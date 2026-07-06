import { describe, expect, it } from 'vitest';
import type { AgentBackend } from '@agentops/backends';
import { StubBackend } from '@agentops/backends';
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
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces: new MemoryWorkspaceManager() as Workspaces,
    prompts: new PromptPack(),
  };
}

describe('createActivities', () => {
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
    expect(deps.stats.all()).toHaveLength(1);
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
    const { prRef } = await activities.openPr({ repo: 'demo/repo', branch: 'b', title: 't', body: 'b' });
    deps.scm.scriptFeedback(prRef, [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    await expect(activities.getPrFeedback(prRef)).resolves.toMatchObject({ ciStatus: 'green' });
    await expect(activities.pushBranch('demo/repo', '/some/workspace', 'branch', 'hash')).resolves.toBeUndefined();
  });
});

describe('createActivities — workspace lifecycle', () => {
  it('prepareWorkspace and cleanupWorkspace delegate to the workspaces dependency', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    const prepared = await activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' });
    expect(prepared).toEqual({ workspaceRef: 'memory://owner/repo/t1', branch: 'agentops/t1', baseBranch: 'main' });

    await activities.cleanupWorkspace(prepared.workspaceRef, 'owner/repo');
    expect((deps.workspaces as MemoryWorkspaceManager).isCleanedUp(prepared.workspaceRef)).toBe(true);
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
      promptContext: { taskId: 't1', goal: 'add a widget', fullVerifyFindings: '', reviewFindings: '' },
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
