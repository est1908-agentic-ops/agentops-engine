import { describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { AgentBackend } from '@agentops/backends';
import type { BackendRunRequest } from '@agentops/contracts';
import { LiteLlmBudgetExceededError, RateWindowExceededError, StubBackend } from '@agentops/backends';
import { MemoryTrackerPort, MemoryScmPort } from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import { ApplicationFailure } from '@temporalio/common';
import { createActivities } from './create-activities';
import { InMemoryStatsStore } from './stats-store';
import { InMemoryStageResultStore } from './stage-result-store';
import { MemoryWorkspaceManager } from './workspace/memory-workspace-manager';
import { WorkspaceError, type Workspaces } from './workspace/workspace-manager';

function buildDeps() {
  return {
    backends: { stub: new StubBackend() } as Record<string, AgentBackend>,
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces: new MemoryWorkspaceManager() as Workspaces,
    prompts: new PromptPack(),
  };
}

describe('createActivities', () => {
  it('runAgent passes image and services through to the backend', async () => {
    const captured: BackendRunRequest[] = [];
    const recording: AgentBackend = {
      async run(req) {
        captured.push(req);
        return { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };
      },
    };
    const deps = { ...buildDeps(), backends: { recording } };
    const activities = createActivities(deps);

    await activities.runAgent({
      taskId: 't1',
      stage: 'full_verify',
      attempt: 1,
      callIndex: 1,
      backend: 'recording',
      model: 'stub-v1',
      image: 'ghcr.io/example/agentops:latest',
      services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
      promptRef: 'full_verify.md',
      promptContext: { taskId: 't1', goal: 'g', verifyCommands: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(captured[0].image).toBe('ghcr.io/example/agentops:latest');
    expect(captured[0].services).toEqual([
      { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
    ]);
  });

  it('runAgent delegates to the named backend', async () => {
    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('implement', 1, { output: 'diff' });
    const activities = createActivities(deps);
    const result = await activities.runAgent({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(result.output).toBe('diff');
  });

  it('runAgent throws for an unregistered backend', async () => {
    const activities = createActivities(buildDeps());
    await expect(
      activities.runAgent({
        taskId: 't1',
        stage: 'implement',
        attempt: 1,
        callIndex: 1,
        backend: 'nonexistent',
        model: 'x',
        promptRef: 'implement.md',
        promptContext: {},
        workspaceRef: 'demo/repo',
        limits: { maxTokens: 1000, timeoutMs: 60_000 },
      }),
    ).rejects.toThrow(/unknown backend/);
  });

  it('recordRunStats and recordStageResult write to the injected stores', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);
    await activities.recordRunStats({
      taskId: 't1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 1,
      tokensOut: 1,
      wallMs: 1,
      outcome: 'pass',
    });
    await activities.recordStageResult({
      taskId: 't1',
      stage: 'implement',
      source: 'agent',
      contentHash: 'h1',
      tokens: 2,
      outcome: 'pass',
    });
    expect(await deps.stats.all()).toHaveLength(1);
    expect(deps.stageResults.forTask('t1')).toHaveLength(1);
  });

  it('getIssue/commentOnIssue/labelIssue delegate to the tracker port', async () => {
    const deps = buildDeps();
    deps.tracker.seedIssue({ ref: 'issue-1', title: 'T', body: 'B', labels: [] });
    const activities = createActivities(deps);
    await expect(activities.getIssue('issue-1')).resolves.toMatchObject({ ref: 'issue-1' });
    await activities.commentOnIssue('issue-1', 'hello');
    await activities.labelIssue('issue-1', 'bug');
    expect(deps.tracker.getComments('issue-1')).toEqual(['hello']);
    expect(deps.tracker.getLabels('issue-1')).toEqual(['bug']);
  });

  it('openPr/getPrFeedback/pushBranch delegate to the scm port', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);
    const { prRef } = await activities.openPr({
      repo: 'demo/repo',
      branch: 'b',
      title: 't',
      body: 'b',
    });
    deps.scm.scriptFeedback(prRef, [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    await expect(activities.getPrFeedback(prRef)).resolves.toMatchObject({ ciStatus: 'green' });
    await expect(
      activities.pushBranch('demo/repo', '/some/workspace', 'branch', 'hash'),
    ).resolves.toBeUndefined();
  });
});

describe('createActivities — tracing', () => {
  it('runAgent attaches gen_ai.*/agentops.* attributes to the active span', async () => {
    // NodeTracerProvider (not the lighter BasicTracerProvider) + .register()
    // is what actually wires up Node's AsyncLocalStorage-based context
    // manager -- without it, `context.active()` doesn't survive the `await
    // backend.run(...)` inside runAgent and the span attribute assertion
    // below fails as if no span were ever active.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    const tracer = provider.getTracer('test');

    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('implement', 2, {
      output: 'diff',
      tokensIn: 12,
      tokensOut: 34,
    });
    const activities = createActivities(deps);

    const span = tracer.startSpan('RunActivity');
    await context.with(trace.setSpan(context.active(), span), () =>
      activities.runAgent({
        taskId: 't1',
        stage: 'implement',
        attempt: 2,
        callIndex: 1,
        backend: 'stub',
        model: 'stub-v1',
        promptRef: 'implement.md',
        promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' },
        workspaceRef: 'demo/repo',
        limits: { maxTokens: 1000, timeoutMs: 60_000 },
      }),
    );
    span.end();

    // SimpleSpanProcessor exports synchronously on span.end() -- read spans
    // before shutdown, which (InMemorySpanExporter specifically) clears its
    // buffer as part of shutting down.
    const [recorded] = exporter.getFinishedSpans();
    await provider.shutdown();
    expect(recorded.attributes).toMatchObject({
      'gen_ai.system': 'stub',
      'gen_ai.request.model': 'stub-v1',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 34,
      'agentops.stage': 'implement',
      'agentops.attempt': 2,
    });
  });

  it('runAgent does not throw when there is no active span', async () => {
    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('implement', 1, { output: 'diff' });
    const activities = createActivities(deps);

    await expect(
      activities.runAgent({
        taskId: 't1',
        stage: 'implement',
        attempt: 1,
        callIndex: 1,
        backend: 'stub',
        model: 'stub-v1',
        promptRef: 'implement.md',
        promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' },
        workspaceRef: 'demo/repo',
        limits: { maxTokens: 1000, timeoutMs: 60_000 },
      }),
    ).resolves.toMatchObject({ output: 'diff' });
  });
});

describe('createActivities — workspace lifecycle', () => {
  it('prepareWorkspace and cleanupWorkspace delegate to the workspaces dependency', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    const prepared = await activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' });
    expect(prepared).toEqual({
      workspaceRef: 'memory://owner/repo/t1',
      branch: 'agentops/t1',
      baseBranch: 'main',
    });

    await activities.cleanupWorkspace(prepared.workspaceRef, 'owner/repo');
    expect((deps.workspaces as MemoryWorkspaceManager).isCleanedUp(prepared.workspaceRef)).toBe(
      true,
    );
  });

  it('prepareWorkspace forwards initCommands through to the workspaces dependency', async () => {
    const captured: (string[] | undefined)[] = [];
    const deps = {
      ...buildDeps(),
      workspaces: {
        prepare: async (_taskId: string, _repo: string, initCommands?: string[]) => {
          captured.push(initCommands);
          return { workspaceRef: 'ref', branch: 'b', baseBranch: 'main' };
        },
        cleanup: async () => {},
      } as Workspaces,
    };
    const activities = createActivities(deps);

    await activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo', initCommands: ['pnpm install'] });

    expect(captured).toEqual([['pnpm install']]);
  });
});

describe('createActivities — prompt rendering', () => {
  it('renders promptRef/promptContext into prompt text before calling the backend', async () => {
    let receivedPrompt = '';
    const fakeBackend: AgentBackend = {
      async run(req) {
        receivedPrompt = req.prompt;
        return { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1 };
      },
    };
    const activities = createActivities({ ...buildDeps(), backends: { stub: fakeBackend } });

    await activities.runAgent({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      promptContext: {
        taskId: 't1',
        goal: 'add a widget',
        fullVerifyFindings: '',
        reviewFindings: '',
      },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(receivedPrompt).toContain('add a widget');
  });

  it('throws when promptContext is missing a variable the template requires', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    await expect(
      activities.runAgent({
        taskId: 't1',
        stage: 'implement',
        attempt: 1,
        callIndex: 1,
        backend: 'stub',
        model: 'stub-v1',
        promptRef: 'implement.md',
        promptContext: { taskId: 't1', goal: 'g' },
        workspaceRef: 'demo/repo',
        limits: { maxTokens: 1000, timeoutMs: 60_000 },
      }),
    ).rejects.toThrow(/fullVerifyFindings/);
  });
});

describe('createActivities — workspace error translation', () => {
  it('converts a non-retryable WorkspaceError into a Temporal ApplicationFailure', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => {
        throw new WorkspaceError('git clone failed for owner/repo: spawn git ENOENT', true);
      },
      cleanup: async () => {},
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' }).catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('passes a retryable WorkspaceError through unchanged', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => {
        throw new WorkspaceError('git fetch failed for owner/repo: network unreachable', false);
      },
      cleanup: async () => {},
    };
    const activities = createActivities(deps);

    await expect(activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' })).rejects.toThrow(WorkspaceError);
  });

  it('converts a non-retryable WorkspaceError from cleanupWorkspace too', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => ({ workspaceRef: 'ref', branch: 'b', baseBranch: 'main' }),
      cleanup: async () => {
        throw new WorkspaceError('git worktree remove failed: spawn git ENOENT', true);
      },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.cleanupWorkspace('ref', 'owner/repo').catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });
});

function runAgentReq(backend: string) {
  return {
    taskId: 't1',
    stage: 'implement' as const,
    attempt: 1,
    callIndex: 1,
    backend,
    model: 'm',
    promptRef: 'implement.md',
    promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' },
    workspaceRef: 'demo/repo',
    limits: { maxTokens: 1000, timeoutMs: 60_000 },
  };
}

describe('createActivities — backend error translation', () => {
  it('converts a LiteLlmBudgetExceededError into a non-retryable ApplicationFailure', async () => {
    const deps = buildDeps();
    deps.backends.litellm = {
      run: async () => {
        throw new LiteLlmBudgetExceededError('Budget has been exceeded! Current cost: 1.20, Max budget: 1.00');
      },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.runAgent(runAgentReq('litellm')).catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('LiteLlmBudgetExceededError');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('converts a RateWindowExceededError into a retryable ApplicationFailure with nextRetryDelay set', async () => {
    const deps = buildDeps();
    deps.backends.claude = {
      run: async () => {
        throw new RateWindowExceededError('claude subscription rate window exhausted, retry in 4200ms', 4200);
      },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.runAgent(runAgentReq('claude')).catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('RateWindowExceededError');
    expect((err as ApplicationFailure).nonRetryable).toBe(false);
    expect((err as ApplicationFailure).nextRetryDelay).toBe(4200);
  });
});
