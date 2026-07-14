/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { AgentBackend } from '@agentops/backends';
import type { BackendRunRequest, ResolvedProjectEntry } from '@agentops/contracts';
import {
  LiteLlmBudgetExceededError,
  ProcessCliAuthError,
  RateLimitError,
  RateWindowExceededError,
  SessionLimitError,
  StubBackend,
} from '@agentops/backends';
import { MemoryTrackerPort, MemoryScmPort } from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import { ApplicationFailure } from '@temporalio/common';
import { createActivities } from './create-activities';
import { InMemoryStatsStore } from './stats-store';
import { InMemoryStageResultStore } from './stage-result-store';
import { InMemoryFiledFindingStore } from './filed-finding-store';
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
    registry: [] as ResolvedProjectEntry[],
    filedFindings: new InMemoryFiledFindingStore(),
    heartbeat: () => {},
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
      services: [
        { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
      ],
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
      promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(result.output).toBe('diff');
  });

  it('runAgent heartbeats once before dispatching to the backend', async () => {
    const heartbeats: unknown[] = [];
    const deps = { ...buildDeps(), heartbeat: (details: unknown) => heartbeats.push(details) };
    (deps.backends.stub as StubBackend).scriptResponse('implement', 1, { output: 'diff' });
    const activities = createActivities(deps);

    await activities.runAgent({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(heartbeats).toEqual([
      { phase: 'started', taskId: 't1', stage: 'implement', attempt: 1, callIndex: 1, backend: 'stub', model: 'stub-v1' },
    ]);
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

  it('createIssue dedups by fingerprint within a project', async () => {
    const tracker = new MemoryTrackerPort();
    const filedFindings = new InMemoryFiledFindingStore();
    const deps = { ...buildDeps(), tracker, filedFindings };
    const activities = createActivities(deps);
    const a = await activities.createIssue({ repo: 'o/r', project: 'p', title: 'T', body: 'B', labels: ['bug'], dedupeFingerprint: 'fp1' });
    const b = await activities.createIssue({ repo: 'o/r', project: 'p', title: 'T2', body: 'B2', labels: ['bug'], dedupeFingerprint: 'fp1' });
    expect(a.deduped).toBe(false);
    expect(b).toEqual({ ref: a.ref, url: '', deduped: true });
  });

  it('runAgent returns a stable promptHash and a promptSource', async () => {
    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('bughunt', 1, { output: 'FINDINGS: []' });
    const activities = createActivities(deps);
    const r = await activities.runAgent({
      taskId: 't1',
      stage: 'bughunt',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    } as never);
    expect(r.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.promptSource).toContain('implement.md');
  });

  it('runAgent records a project-repo promptSource when provided', async () => {
    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('bughunt', 1, { output: 'FINDINGS: []' });
    const activities = createActivities(deps);
    const res = await activities.runAgent({
      taskId: 't1', stage: 'bughunt', repo: 'acme/web', project: 'acme', attempt: 1, callIndex: 1, backend: 'stub', model: 'm',
      promptRef: 'implement.md', promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' }, workspaceRef: 'ws',
      limits: { maxTokens: 1000, maxIterations: 1, maxImplementAttempts: 1, maxBabysitRounds: 1 },
      promptSource: { repo: 'acme/web', commit: 'abc123', path: 'agentops/prompts/x.md' },
    } as any);
    expect(res.promptSource).toBe('acme/web@abc123:agentops/prompts/x.md');
  });
  it('runAgent defaults to builtin:<ref> when no project source is given', async () => {
    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('bughunt', 1, { output: 'FINDINGS: []' });
    const activities = createActivities(deps);
    const res = await activities.runAgent({
      taskId: 't1', stage: 'bughunt', repo: 'o/r', project: 'p', attempt: 1, callIndex: 1, backend: 'stub', model: 'm',
      promptRef: 'implement.md', promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' }, workspaceRef: 'ws',
      limits: { maxTokens: 1000, maxIterations: 1, maxImplementAttempts: 1, maxBabysitRounds: 1 },
    } as any);
    expect(res.promptSource).toBe('builtin:implement.md');
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
        promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' },
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
        promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' },
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
        prepareScratch: async () => ({ workspaceRef: 'scratch-ref' }),
        cleanupScratch: async () => {},
        pruneOrphans: async () => ({ removed: [] }),
        readFile: async () => null,
      } as Workspaces,
    };
    const activities = createActivities(deps);

    await activities.prepareWorkspace({
      taskId: 't1',
      repo: 'owner/repo',
      initCommands: ['pnpm install'],
    });

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
        prReviewFeedback: '',
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
      prepareScratch: async () => ({ workspaceRef: 'scratch-ref' }),
      cleanupScratch: async () => {},
      pruneOrphans: async () => ({ removed: [] }),
      readFile: async () => null,
    };
    const activities = createActivities(deps);

    const err: unknown = await activities
      .prepareWorkspace({ taskId: 't1', repo: 'owner/repo' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('wraps a retryable WorkspaceError in a retryable ApplicationFailure', async () => {
    // After #23, retryable WorkspaceErrors are also wrapped in an
    // ApplicationFailure (nonRetryable: false) so Temporal's retry policy
    // applies -- previously they leaked through unwrapped and were never
    // retried despite the configured maximumAttempts.
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => {
        throw new WorkspaceError('git fetch failed for owner/repo: network unreachable', false);
      },
      cleanup: async () => {},
      prepareScratch: async () => ({ workspaceRef: 'scratch-ref' }),
      cleanupScratch: async () => {},
      pruneOrphans: async () => ({ removed: [] }),
      readFile: async () => null,
    };
    const activities = createActivities(deps);

    const err: unknown = await activities
      .prepareWorkspace({ taskId: 't1', repo: 'owner/repo' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(false);
    expect((err as ApplicationFailure).type).toBe('WorkspaceError');
  });

  it('converts a non-retryable WorkspaceError from cleanupWorkspace too', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => ({ workspaceRef: 'ref', branch: 'b', baseBranch: 'main' }),
      cleanup: async () => {
        throw new WorkspaceError('git worktree remove failed: spawn git ENOENT', true);
      },
      prepareScratch: async () => ({ workspaceRef: 'scratch-ref' }),
      cleanupScratch: async () => {},
      pruneOrphans: async () => ({ removed: [] }),
      readFile: async () => null,
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
    promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '', prReviewFeedback: '' },
    workspaceRef: 'demo/repo',
    limits: { maxTokens: 1000, timeoutMs: 60_000 },
  };
}

describe('createActivities — backend error translation', () => {
  it('converts a LiteLlmBudgetExceededError into a non-retryable ApplicationFailure', async () => {
    const deps = buildDeps();
    deps.backends.litellm = {
      run: async () => {
        throw new LiteLlmBudgetExceededError(
          'Budget has been exceeded! Current cost: 1.20, Max budget: 1.00',
        );
      },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.runAgent(runAgentReq('litellm')).catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('LiteLlmBudgetExceededError');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('converts a ProcessCliAuthError into a non-retryable ApplicationFailure typed AuthError', async () => {
    const deps = buildDeps();
    deps.backends.claude = {
      run: async () => {
        throw new ProcessCliAuthError(
          'claude reported is_error: Failed to authenticate. API Error: 401 token expired or incorrect',
        );
      },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.runAgent(runAgentReq('claude')).catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('AuthError');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('converts a RateWindowExceededError into a retryable ApplicationFailure with nextRetryDelay set', async () => {
    const deps = buildDeps();
    deps.backends.claude = {
      run: async () => {
        throw new RateWindowExceededError(
          'claude subscription rate window exhausted, retry in 4200ms',
          4200,
        );
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

describe('createActivities — tier resolution + fallback', () => {
  it('resolves a tier ref and dispatches to its primary entry', async () => {
    const captured: BackendRunRequest[] = [];
    const claude: AgentBackend = {
      run: async (req) => {
        captured.push(req);
        return { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };
      },
    };
    const deps = { ...buildDeps(), backends: { claude } };
    const activities = createActivities(deps);

    const result = await activities.runAgent({
      taskId: 't1',
      stage: 'design',
      attempt: 1,
      callIndex: 1,
      tier: 'smart',
      promptRef: 'design.md',
      promptContext: { taskId: 't1', goal: 'g' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(result.output).toBe('ok');
    // 'smart' tier's primary is claude/opus -- the activity resolved it.
    expect(captured[0].backend).toBe('claude');
    expect(captured[0].model).toBe('opus');
    expect(result.resolvedBackend).toBe('claude');
    expect(result.resolvedModel).toBe('opus');
  });

  it('falls back cross-backend on SessionLimitError and attributes to the fallback', async () => {
    const claude: AgentBackend = {
      run: async () => { throw new SessionLimitError('session limit'); },
    };
    const pi: AgentBackend = {
      run: async () => ({ output: 'fallback', tokensIn: 1, tokensOut: 1, wallMs: 1 }),
    };
    const deps = { ...buildDeps(), backends: { claude, pi } };
    const activities = createActivities(deps);

    const result = await activities.runAgent({
      taskId: 't1',
      stage: 'design',
      attempt: 1,
      callIndex: 1,
      tier: 'smart',
      promptRef: 'design.md',
      promptContext: { taskId: 't1', goal: 'g' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(result.output).toBe('fallback');
    // Attribution: the fallback (pi/zai/glm-5.2) served the call, not claude.
    expect(result.resolvedBackend).toBe('pi');
    expect(result.resolvedModel).toBe('zai/glm-5.2');
  });

  it('maps SessionLimitExhaustedError to a non-retryable ApplicationFailure', async () => {
    // Both tier entries throw SessionLimitError -> chain exhausted.
    const sessionLimited: AgentBackend = {
      run: async () => { throw new SessionLimitError('session limit'); },
    };
    const deps = {
      ...buildDeps(),
      backends: { claude: sessionLimited, pi: sessionLimited },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities
      .runAgent({
        taskId: 't1', stage: 'design', attempt: 1, callIndex: 1, tier: 'smart',
        promptRef: 'design.md', promptContext: { taskId: 't1', goal: 'g' },
        workspaceRef: 'demo/repo', limits: { maxTokens: 1000, timeoutMs: 60_000 },
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('SessionLimitExhaustedError');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('maps RateLimitError to a retryable ApplicationFailure with a nextRetryDelay', async () => {
    const claude: AgentBackend = {
      run: async () => { throw new RateLimitError('429 rate limit'); },
    };
    const deps = { ...buildDeps(), backends: { claude } };
    const activities = createActivities(deps);

    const err: unknown = await activities
      .runAgent({
        taskId: 't1', stage: 'design', attempt: 1, callIndex: 1, tier: 'smart',
        promptRef: 'design.md', promptContext: { taskId: 't1', goal: 'g' },
        workspaceRef: 'demo/repo', limits: { maxTokens: 1000, timeoutMs: 60_000 },
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('RateLimitError');
    expect((err as ApplicationFailure).nonRetryable).toBe(false);
    expect((err as ApplicationFailure).nextRetryDelay).toBeGreaterThan(0);
  });
});

describe('createActivities — runAgent project authorization', () => {
  it('rejects a project-scoped caller requesting the platform backend directly', async () => {
    const { projectContext } = await import('./project-context');
    const platform: AgentBackend = { run: async () => ({ output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1 }) };
    const deps = { ...buildDeps(), backends: { platform } };
    const activities = createActivities(deps);

    const err: unknown = await projectContext
      .run({ project: 'acme' }, () =>
        activities.runAgent({
          taskId: 't1', stage: 'agent', attempt: 1, callIndex: 1, backend: 'platform', model: 'claude-sonnet-5',
          promptRef: 'agent.md', promptContext: { taskId: 't1', instructions: 'x' },
          workspaceRef: 'memory://scratch/t1', limits: { maxTokens: 1000, timeoutMs: 60_000 },
        }),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('ProjectAuthorizationError');
  });

  it('rejects a project-scoped caller whose own projectTiers resolves to the platform backend', async () => {
    const { projectContext } = await import('./project-context');
    const platform: AgentBackend = { run: async () => ({ output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1 }) };
    const deps = { ...buildDeps(), backends: { platform } };
    const activities = createActivities(deps);

    const err: unknown = await projectContext
      .run({ project: 'acme' }, () =>
        activities.runAgent({
          taskId: 't1', stage: 'agent', attempt: 1, callIndex: 1,
          tier: 'sneaky', projectTiers: { sneaky: [{ backend: 'platform', model: 'claude-sonnet-5' }] },
          promptRef: 'agent.md', promptContext: { taskId: 't1', instructions: 'x' },
          workspaceRef: 'memory://scratch/t1', limits: { maxTokens: 1000, timeoutMs: 60_000 },
        }),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('ProjectAuthorizationError');
  });

  it('allows an engine-internal caller (no project in context) to use the platform backend', async () => {
    const platform: AgentBackend = { run: async () => ({ output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1 }) };
    const deps = { ...buildDeps(), backends: { platform } };
    const activities = createActivities(deps);

    const result = await activities.runAgent({
      taskId: 't1', stage: 'platform', attempt: 1, callIndex: 1, backend: 'platform', model: 'claude-sonnet-5',
      promptRef: 'platform.md', promptContext: { taskId: 't1', prompt: 'p', hintRepos: '' },
      workspaceRef: 'memory://scratch/t1', limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(result.output).toBe('ok');
  });
});

describe('createActivities — resolveRepoConfig', () => {
  it("resolves project from the registry and loads that repo's ProjectConfig", async () => {
    const deps = buildDeps();
    deps.scm.seedFile(
      'flair-hr/agentops-engine',
      'agentops.json',
      JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }),
    );
    deps.registry = [
      {
        project: 'engine',
        repo: 'flair-hr/agentops-engine',
        trackerType: 'github',
        token: 'fake',
      },
    ];
    const activities = createActivities(deps);

    const { registered, project, config } = await activities.resolveRepoConfig(
      'flair-hr/agentops-engine',
    );

    expect(registered).toBe(true);
    expect(project).toBe('engine');
    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('reports unregistered instead of touching the SCM when the repo is not in the registry', async () => {
    const deps = buildDeps();
    const readFileSpy = vi.spyOn(deps.scm, 'readFile');
    const activities = createActivities(deps);

    const { registered, project } = await activities.resolveRepoConfig('flair-hr/some-other-repo');

    expect(registered).toBe(false);
    expect(project).toBe('default');
    // No registry entry means no SCM credentials scoped to this repo either --
    // the real (non-fake) ScmPort throws for any repo it isn't configured
    // for, so resolveRepoConfig must never reach it for an unregistered repo.
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('createIssue throws ProjectAuthorizationError when caller project does not own the repo', async () => {
    const { projectContext } = await import('./project-context');
    const tracker = new MemoryTrackerPort();
    const deps = { ...buildDeps(), tracker, registry: [{ project: 'acme', repo: 'acme/web', trackerType: 'github' as const, token: 't' }] };
    const activities = createActivities(deps);
    await expect(
      projectContext.run({ project: 'other' }, () =>
        activities.createIssue({ repo: 'acme/web', project: 'acme', title: 't', body: 'b', labels: [] }),
      ),
    ).rejects.toThrow(/ProjectAuthorizationError|not authorized/);
  });

  it('unlabelIssue delegates to tracker.removeLabel', async () => {
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    const deps = { ...buildDeps(), tracker: { removeLabel } as any };
    const activities = createActivities(deps);
    await activities.unlabelIssue('o/r#1', 'agent:working');
    expect(removeLabel).toHaveBeenCalledWith('o/r#1', 'agent:working');
  });

  it('listManagedProjects returns registry {project,repo} pairs', async () => {
    const deps = {
      ...buildDeps(),
      registry: [{ project: 'acme', repo: 'acme/web', token: 't', trackerType: 'github' as const }],
    };
    const activities = createActivities(deps);
    expect(await activities.listManagedProjects()).toEqual([{ project: 'acme', repo: 'acme/web' }]);
  });

  it('applyScheduleChanges uses the agent taskQueue for a scheduled Tier-2 agent', async () => {
    const create = vi.fn().mockResolvedValue({});
    const deps = {
      ...buildDeps(),
      scheduleClient: { create, getHandle: () => ({}) } as any,
      taskQueue: 'agentops-engine',
      registry: [],
    } as any;
    const activities = createActivities(deps);
    const plan = {
      toCreate: [{ name: 'nightly', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip', taskQueue: 'proj-acme' }],
      toUpdate: [], toDelete: [], toPause: [], toResume: [],
    } as any;
    await activities.applyScheduleChanges('acme', 'acme/web', plan);
    expect(create.mock.calls[0][0].action.taskQueue).toBe('proj-acme');
    // The schedule spec must use the SDK's cronExpressions shape, not
    // spec.cron.cronString (which the client ignores -> schedule never fires).
    expect(create.mock.calls[0][0].spec.cronExpressions).toEqual(['0 2 * * *']);
    expect(create.mock.calls[0][0].spec.timezone).toBe('UTC');
    expect(create.mock.calls[0][0].spec.cron).toBeUndefined();
  });

  it('applyScheduleChanges stamps repo + project/agentName/workflowType and search attributes', async () => {
    const create = vi.fn().mockResolvedValue({});
    const getHandle = vi.fn(() => ({}));
    const deps = {
      ...buildDeps(),
      scheduleClient: { create, getHandle } as any,
      registry: [{ project: 'acme', repo: 'acme/web', trackerType: 'github' as const, token: 't' }],
    } as any;
    const activities = createActivities(deps);
    const plan = {
      toCreate: [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: { focus: 'auth' }, enabled: true, timezone: 'UTC', overlap: 'skip' }],
      toUpdate: [], toDelete: [], toPause: [], toResume: [],
    } as any;
    await activities.applyScheduleChanges('acme', 'acme/web', plan);
    const arg = create.mock.calls[0][0];
    expect(arg.action.args[0]).toMatchObject({ repo: 'acme/web', project: 'acme', focus: 'auth' });
    expect(arg.memo).toMatchObject({ project: 'acme', agentName: 'nb', workflowType: 'whiteboxBugHunt' });
    expect(arg.searchAttributes).toMatchObject({ project: ['acme'], agentName: ['nb'], workflowType: ['whiteboxBugHunt'] });
  });

  it('applyScheduleChanges updates an existing schedule via an updater function, matching the real ScheduleHandle.update contract', async () => {
    // Regression test: the real @temporalio/client ScheduleHandle.update() takes
    // an updater function (previous) => newSchedule, not a plain options object.
    // A prior version of this code called h.update?.(plainObject), which
    // type-checked against our own mock-friendly ScheduleClientLike but threw at
    // runtime against the real client -- silently swallowed by .catch(() => {}),
    // so an already-existing schedule's stale taskQueue (e.g. an unslugified
    // project name) could never actually be corrected by reconcile.
    const update = vi.fn(async (updateFn: (previous: unknown) => unknown) => {
      update.lastResult = await updateFn({ action: { taskQueue: 'proj-Artem private agents' }, spec: { cronExpressions: ['0 */2 * * *'], timezone: 'UTC' } });
    }) as any;
    const getHandle = vi.fn(() => ({ update }));
    const deps = {
      ...buildDeps(),
      scheduleClient: { getHandle } as any,
      registry: [{ project: 'Artem private agents', repo: 'est1908/agents', trackerType: 'github' as const, token: 't' }],
    } as any;
    const activities = createActivities(deps);
    const plan = {
      toCreate: [],
      toUpdate: [{ name: 'gdebenz-watch', workflow: 'productOwnerReview', schedule: '0 */2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' }],
      toDelete: [], toPause: [], toResume: [],
    } as any;
    await activities.applyScheduleChanges('Artem private agents', 'est1908/agents', plan);
    expect(getHandle).toHaveBeenCalledWith('agent:Artem private agents:gdebenz-watch');
    expect(update).toHaveBeenCalledTimes(1);
    expect(typeof update.mock.calls[0][0]).toBe('function');
    expect(update.lastResult.action.taskQueue).toBe('proj-artem-private-agents');
  });

  it('startContinuousAgent starts a singleton by deterministic id with identity + taskQueue, tolerating AlreadyStarted', async () => {
    const start = vi.fn().mockResolvedValue({});
    const deps = {
      ...buildDeps(),
      workflowClient: { start, list: async function* () {} } as any,
      registry: [],
    } as any;
    const activities = createActivities(deps);
    const spec = { name: 'mon', workflow: 'rollbarMonitor', schedule: 'continuous', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip', taskQueue: 'proj-acme' } as any;
    await activities.startContinuousAgent('acme', 'acme/web', spec);
    const [wf, opts] = start.mock.calls[0];
    expect(wf).toBe('rollbarMonitor');
    expect(opts.workflowId).toBe('agent:acme:mon');
    expect(opts.taskQueue).toBe('proj-acme');
    expect(opts.memo).toMatchObject({ project: 'acme', agentName: 'mon', workflowType: 'rollbarMonitor' });
    expect(opts.searchAttributes).toMatchObject({ project: ['acme'] });
    expect(opts.args[0]).toMatchObject({ repo: 'acme/web', project: 'acme' });
  });

  it('listContinuousAgents excludes an in-flight scheduled run sharing the same id prefix', async () => {
    // A Temporal Schedule fires workflows as `<scheduleId>-workflow-<timestamp>`,
    // which shares the `agent:<project>:` prefix with a genuine continuous
    // singleton (started at the bare `agent:<project>:<name>` id). Only the
    // bare id is a true singleton -- a scheduled agent mid-run must not be
    // swept up and terminated as an "orphaned continuous agent".
    const singleton = { workflowId: 'agent:acme:mon', searchAttributes: { agentName: ['mon'] } };
    const scheduledRun = {
      workflowId: 'agent:acme:nightly-workflow-2026-07-13T19:09:49Z',
      searchAttributes: { agentName: ['nightly'] },
    };
    const deps = {
      ...buildDeps(),
      workflowClient: {
        list: async function* () {
          yield singleton;
          yield scheduledRun;
        },
      } as any,
      registry: [],
    } as any;
    const activities = createActivities(deps);
    expect(await activities.listContinuousAgents('acme')).toEqual(['agent:acme:mon']);
  });

  it('terminateContinuousAgent terminates the handle with the manifest-removed reason', async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...buildDeps(),
      workflowClient: { getHandle: () => ({ terminate }) } as any,
      registry: [],
    } as any;
    const activities = createActivities(deps);
    await activities.terminateContinuousAgent('agent:acme:mon');
    expect(terminate).toHaveBeenCalledWith('agent removed from manifest');
  });
});

describe('createActivities — scratch workspace lifecycle', () => {
  it('prepareScratchWorkspace and cleanupScratchWorkspace delegate to the workspaces dependency', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    const { workspaceRef } = await activities.prepareScratchWorkspace('platform-task-1');
    expect((deps.workspaces as MemoryWorkspaceManager).isScratchPrepared(workspaceRef)).toBe(true);

    await activities.cleanupScratchWorkspace(workspaceRef);
    expect((deps.workspaces as MemoryWorkspaceManager).isScratchCleanedUp(workspaceRef)).toBe(true);
  });
});
