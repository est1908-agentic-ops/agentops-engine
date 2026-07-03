import { describe, expect, it } from 'vitest';
import { StubBackend } from '@agentops/backends';
import { MemoryTrackerPort, MemoryScmPort } from '@agentops/ports';
import { createActivities } from './create-activities';
import { InMemoryStatsStore } from './stats-store';
import { InMemoryStageResultStore } from './stage-result-store';

function buildDeps() {
  return {
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
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
    await expect(activities.pushBranch('branch', 'hash')).resolves.toBeUndefined();
  });
});
