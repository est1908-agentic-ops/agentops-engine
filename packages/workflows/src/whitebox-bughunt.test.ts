import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskInput } from '@agentops/contracts';

const { resolveRepoConfig, prepareWorkspace, cleanupWorkspace, recordRunStats, createIssue, runAgent } = vi.hoisted(
  () => ({
    resolveRepoConfig: vi.fn(),
    prepareWorkspace: vi.fn().mockResolvedValue({ workspaceRef: 'ws', branch: 'br', baseBranch: 'main' }),
    cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    recordRunStats: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ ref: 'o/r#1', url: 'http://issue', deduped: false }),
    runAgent: vi.fn().mockResolvedValue({
      output: 'no findings',
      tokensIn: 1,
      tokensOut: 1,
      wallMs: 1,
      promptHash: 'h',
      promptSource: 's',
    }),
  }),
);

const workflowId = 'agent:Artem private agents:bughunt-test-workflow-2026-07-13T12:00:00Z';

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (opts: { heartbeatTimeout?: string }) =>
    opts.heartbeatTimeout ? { runAgent } : { resolveRepoConfig, prepareWorkspace, cleanupWorkspace, recordRunStats, createIssue },
  workflowInfo: () => ({ workflowId, workflowType: 'whiteboxBugHunt' }),
}));

import { whiteboxBugHunt } from './whitebox-bughunt';

const config: TaskInput['config'] = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
};

describe('whiteboxBugHunt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgent.mockResolvedValue({
      output: 'no findings',
      tokensIn: 1,
      tokensOut: 1,
      wallMs: 1,
      promptHash: 'h',
      promptSource: 's',
    });
    prepareWorkspace.mockResolvedValue({ workspaceRef: 'ws', branch: 'br', baseBranch: 'main' });
    createIssue.mockResolvedValue({ ref: 'o/r#1', url: 'http://issue', deduped: false });
  });

  it('slugifies the schedule-derived workflowId before using it as taskId (git branch / workspace dir safety)', async () => {
    resolveRepoConfig.mockResolvedValue({ registered: true, project: 'Artem private agents', config });

    await whiteboxBugHunt({ repo: 'est1908/agents' });

    // Regression: prepareWorkspace failed with "not a valid branch name" when
    // called with the raw workflowId (`:` and spaces from the project name).
    expect(prepareWorkspace).toHaveBeenCalledWith({
      taskId: 'agent-artem-private-agents-bughunt-test-workflow-2026-07-13t12-00-00z',
      repo: 'est1908/agents',
    });
    const taskId = prepareWorkspace.mock.calls[0][0].taskId;
    expect(taskId).toMatch(/^[a-z0-9-]+$/);
  });

  it('runs the bughunt agent and files a finding', async () => {
    resolveRepoConfig.mockResolvedValue({ registered: true, project: 'Artem private agents', config });
    runAgent.mockResolvedValueOnce({
      output: 'FINDINGS: [{"title":"t","detail":"d","severity":"low","location":"x"}]',
      tokensIn: 1,
      tokensOut: 1,
      wallMs: 1,
      promptHash: 'h',
      promptSource: 's',
    });

    const result = await whiteboxBugHunt({ repo: 'est1908/agents' });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspace).toHaveBeenCalledWith('ws', 'est1908/agents');
    expect(result.filed).toBe(1);
    expect(result.deduped).toBe(0);
  });
});
