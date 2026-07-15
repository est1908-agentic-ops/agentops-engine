import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { TaskInput } from '@agentops/contracts';

const {
  labelIssue,
  unlabelIssue,
  getIssue,
  prepareWorkspace,
  openPr,
  pushBranch,
  getPrFeedback,
  getPrSnapshot,
  cleanupWorkspace,
  recordStageResult,
  recordRunStats,
  runAgent,
  patched,
  startChild,
} = vi.hoisted(() => {
  const runAgentFn = vi.fn().mockImplementation(async (req: { stage: string }) => {
    const outputs: Record<string, string> = {
      context: 'ctx',
      design: 'design',
      plan: 'plan',
      implement: 'diff',
      full_verify: 'FULL: PASS',
      review: 'VERDICT: PASS',
    };
    return { output: outputs[req.stage] ?? 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1, promptHash: 'h', promptSource: 's' };
  });
  return {
    labelIssue: vi.fn().mockResolvedValue(undefined),
    unlabelIssue: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue({ ref: 'o/r#5', title: 'fix', body: '', labels: [] }),
    prepareWorkspace: vi.fn().mockResolvedValue({ workspaceRef: 'ws', branch: 'br', baseBranch: 'main' }),
    openPr: vi.fn().mockResolvedValue({ prRef: 'pr-1', url: 'http://pr' }),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    getPrFeedback: vi.fn().mockResolvedValue({ ciStatus: 'green', unresolvedThreads: 0, comments: [] }),
    getPrSnapshot: vi.fn().mockResolvedValue({
      prRef: 'pr-1', headSha: 'abc', headRepo: 'o/r', headBranch: 'br', checkoutRef: 'refs/pull/1/head',
      labels: ['agentops:managed'], state: 'open', draft: false, mergeable: true, mergedHeadSha: null,
      ciStatus: 'green', unresolvedThreads: 0, comments: [],
    }),
    cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    patched: vi.fn().mockReturnValue(false),
    startChild: vi.fn().mockResolvedValue({
      result: vi.fn().mockResolvedValue({ outcome: 'merged' }),
      signal: vi.fn().mockResolvedValue(undefined),
    }),
    recordStageResult: vi.fn().mockResolvedValue(undefined),
    recordRunStats: vi.fn().mockResolvedValue(undefined),
    runAgent: runAgentFn,
  };
});

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (opts: { heartbeatTimeout?: string }) => {
    if (opts.heartbeatTimeout) {
      return { runAgent };
    }
    return {
      prepareWorkspace,
      getIssue,
      labelIssue,
      unlabelIssue,
      openPr,
      pushBranch,
      getPrFeedback,
      getPrSnapshot,
      cleanupWorkspace,
      recordStageResult,
      recordRunStats,
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    };
  },
  condition: vi.fn().mockResolvedValue(undefined),
  sleep: vi.fn().mockResolvedValue(undefined),
  defineQuery: vi.fn(() => 'stateQuery'),
  defineSignal: vi.fn(() => 'signal'),
  setHandler: vi.fn(),
  patched,
  startChild,
  trace: { getActiveSpan: () => ({ setAttributes: vi.fn() }) },
  ActivityFailure: class ActivityFailure extends Error {},
  ApplicationFailure: class ApplicationFailure extends Error {
    type = '';
  },
}));

import { devCycle } from './dev-cycle';

const config: TaskInput['config'] = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
};

describe('devCycle agent:working label lifecycle', () => {
  it('stamps agent:working on start and drops it at PR open (issue-linked run)', async () => {
    await devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: 'fix',
      config,
    });
    expect(labelIssue).toHaveBeenCalledWith('o/r#5', 'agent:working');
    expect(unlabelIssue).toHaveBeenCalledWith('o/r#5', 'agent:working');
  });

  it('passes issue labels to openPr', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({ ref: 'o/r#5', title: 'fix', body: '', labels: ['agentops', 'bug'] });
    await devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: 'fix',
      config,
    });
    expect(openPr).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['agentops', 'bug', 'agentops:managed'],
      }),
    );
  });

  it('always adds agentops:managed even when the issue has no labels', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({ ref: 'o/r#5', title: 'fix', body: '', labels: [] });
    await devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: 'fix',
      config,
    });
    expect(openPr).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['agentops', 'agentops:managed'],
      }),
    );
  });

  it('truncates very long goals to fit GitHub PR title limit (256 chars)', async () => {
    const longGoal = 'lorem ipsum '.repeat(50);
    await devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: longGoal,
      config,
    });
    const call = vi.mocked(openPr).mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();
    expect(call!.title.length).toBeLessThanOrEqual(256);
    expect(call!.title).toContain('…');
  });

  it('passes short goals through to openPr title unchanged', async () => {
    const shortGoal = 'fix typo in readme';
    await devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: shortGoal,
      config,
    });
    const call = vi.mocked(openPr).mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();
    expect(call!.title).toBe(shortGoal);
  });
});

describe('devCycle shared prLanding handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(patched).mockReturnValue(true);
    vi.mocked(startChild).mockResolvedValue({
      result: vi.fn().mockResolvedValue({ outcome: 'merged' }),
      signal: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('hands the worktree to prLanding and does not clean up in the parent', async () => {
    const result = await devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: 'fix',
      config,
    });
    expect(startChild).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      workflowId: 'pr-landing-pr-1',
      args: [expect.objectContaining({
        agentCreated: true,
        workspace: { workspaceRef: 'ws', branch: 'br', validatedHeadSha: 'abc' },
      })],
    }));
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(result.landingOutcome).toBe('merged');
    expect(result.status).toBe('done');
  });
});