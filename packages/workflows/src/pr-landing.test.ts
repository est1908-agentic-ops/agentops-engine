import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrLandingInput, PrSnapshot } from '@agentops/contracts';

const greenSnapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  prRef: 'o/r#7',
  headSha: 'abc',
  headRepo: 'o/r',
  headBranch: 'agentops/t',
  checkoutRef: 'refs/pull/7/head',
  labels: [],
  state: 'open',
  draft: false,
  mergeable: true,
  mergedHeadSha: null,
  ciStatus: 'green',
  unresolvedThreads: 0,
  comments: [],
  ...overrides,
});

const handlers: Record<string, () => void> = {};

const {
  prepareWorkspace,
  cleanupWorkspace,
  getPrSnapshot,
  mergePr,
  pushBranch,
  recordStageResult,
  recordRunStats,
  runAgent,
  condition,
} = vi.hoisted(() => {
  const runAgentFn = vi.fn().mockImplementation(async (req: { stage: string }) => {
    const outputs: Record<string, string> = {
      implement: 'diff',
      full_verify: 'FULL: PASS',
      review: 'VERDICT: PASS',
    };
    return {
      output: outputs[req.stage] ?? 'ok',
      tokensIn: 1,
      tokensOut: 1,
      wallMs: 1,
      promptHash: 'h',
      promptSource: 's',
    };
  });
  let poll = 0;
  const getPrSnapshotFn = vi.fn().mockImplementation(async () => {
    poll += 1;
    return greenSnapshot(poll === 1 ? {} : { labels: ['automerge'] });
  });
  return {
    prepareWorkspace: vi
      .fn()
      .mockResolvedValue({ workspaceRef: 'ws-ext', branch: 'feature/x', baseBranch: 'main' }),
    cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    getPrSnapshot: getPrSnapshotFn,
    mergePr: vi.fn().mockResolvedValue({ kind: 'merged', headSha: 'abc', mergeCommitSha: 'def' }),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    recordStageResult: vi.fn().mockResolvedValue(undefined),
    recordRunStats: vi.fn().mockResolvedValue(undefined),
    runAgent: runAgentFn,
    condition: vi.fn().mockImplementation(async (_pred: () => boolean, timeout?: number) => {
      if (timeout) return;
    }),
  };
});

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (opts: { heartbeatTimeout?: string }) => {
    if (opts.heartbeatTimeout) {
      return { runAgent };
    }
    return {
      prepareWorkspace,
      cleanupWorkspace,
      getPrSnapshot,
      mergePr,
      pushBranch,
      recordStageResult,
      recordRunStats,
      resolveRepoConfig: vi.fn().mockResolvedValue({ registered: true, project: 'p', config: {} }),
    };
  },
  condition,
  sleep: vi.fn().mockResolvedValue(undefined),
  defineQuery: vi.fn(() => 'stateQuery'),
  defineSignal: vi.fn((name: string) => name),
  setHandler: vi.fn((token: string, fn: () => void) => {
    handlers[token] = fn;
  }),
  ActivityFailure: class ActivityFailure extends Error {},
  ApplicationFailure: class ApplicationFailure extends Error {
    type = '';
  },
}));

import { prLanding } from './pr-landing';

const baseConfig: NonNullable<PrLandingInput['config']> = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
};

describe('prLanding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    vi.mocked(getPrSnapshot).mockImplementation(async () =>
      greenSnapshot({ labels: ['automerge'] }),
    );
    vi.mocked(runAgent).mockImplementation(async (req: { stage: string }) => {
      const outputs: Record<string, string> = {
        implement: 'diff',
        full_verify: 'FULL: PASS',
        review: 'VERDICT: PASS',
      };
      return {
        output: outputs[req.stage] ?? 'ok',
        tokensIn: 1,
        tokensOut: 1,
        wallMs: 1,
        promptHash: 'h',
        promptSource: 's',
      };
    });
    vi.mocked(mergePr).mockResolvedValue({ kind: 'merged', headSha: 'abc', mergeCommitSha: 'def' });
    vi.mocked(condition).mockImplementation(async () => undefined);
  });

  it('adopts but does not prepare the parent workspace, then cleans it once', async () => {
    const result = await prLanding({
      taskId: 'landing-o-r-7',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#7',
      agentCreated: true,
      workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' },
      config: { ...baseConfig, autoMerge: 'disabled' },
    });
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('merge-ready-manual');
  });

  it('prepares an external PR workspace and runs verify plus review before merging', async () => {
    const result = await prLanding({
      taskId: 'landing-o-r-8',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#8',
      agentCreated: false,
      headBranch: 'feature/x',
      config: { ...baseConfig, autoMerge: 'label' },
    });
    expect(prepareWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ headBranch: 'feature/x' }),
    );
    expect(runAgent.mock.calls.map(([req]) => req.stage)).toEqual(['full_verify', 'review']);
    expect(result.outcome).toBe('merged');
  });

  it('returns manual when automerge:disable wins immediately before merge', async () => {
    vi.mocked(getPrSnapshot).mockResolvedValue(
      greenSnapshot({ labels: ['automerge', 'automerge:disable'] }),
    );
    const result = await prLanding({
      taskId: 'landing-o-r-9',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#9',
      agentCreated: true,
      workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' },
      config: { ...baseConfig, autoMerge: 'all' },
    });
    expect(mergePr).not.toHaveBeenCalled();
    expect(result.outcome).toBe('merge-ready-manual');
  });

  it('recognizes externally merged PRs when merge commit differs from head', async () => {
    vi.mocked(getPrSnapshot)
      .mockResolvedValueOnce(greenSnapshot({ labels: ['automerge'] }))
      .mockResolvedValueOnce(greenSnapshot({ labels: ['automerge'] }))
      .mockResolvedValueOnce(greenSnapshot({ labels: ['automerge'] }))
      .mockResolvedValueOnce(
        greenSnapshot({
          state: 'merged',
          headSha: 'abc',
          mergedHeadSha: 'merge-commit-def',
          labels: ['automerge'],
        }),
      );

    const result = await prLanding({
      taskId: 'landing-o-r-11',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#11',
      agentCreated: true,
      workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' },
      config: { ...baseConfig, autoMerge: 'disabled' },
    });

    expect(mergePr).not.toHaveBeenCalled();
    expect(result.outcome).toBe('merged');
  });

  it('blocks on forbidden merge and still cleans up once', async () => {
    vi.mocked(mergePr).mockResolvedValue({ kind: 'forbidden', reason: 'nope' });
    const result = await prLanding({
      taskId: 'landing-o-r-10',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#10',
      agentCreated: false,
      headBranch: 'feature/x',
      config: { ...baseConfig, autoMerge: 'label' },
    });
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('blocked');
    expect(result.blockReason).toBe('permission-denied');
  });

  it('cancels during babysit loop poll', async () => {
    vi.mocked(getPrSnapshot).mockResolvedValue(
      greenSnapshot({ ciStatus: 'pending', unresolvedThreads: 0, comments: [] }),
    );
    vi.mocked(condition).mockImplementation(async (pred: () => boolean, timeout?: number) => {
      if (timeout === 5000) {
        // This is the babysit poll; invoke cancel handler and resolve
        handlers['cancel']?.();
        // Return true to indicate the predicate was satisfied
        return;
      }
      // Other conditions resolve immediately
      return;
    });
    const result = await prLanding({
      taskId: 'landing-o-r-12',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#12',
      agentCreated: true,
      workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' },
      config: { ...baseConfig, autoMerge: 'label' },
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.phase).toBe('done');
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(mergePr).not.toHaveBeenCalled();
  });

  it('cancels during repair loop iteration', async () => {
    let implementCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (req: { stage: string }) => {
      if (req.stage === 'implement') {
        implementCalls += 1;
        // Invoke cancel on the implement stage call
        handlers['cancel']?.();
      }
      const outputs: Record<string, string> = {
        implement: 'diff',
        full_verify: 'FULL: FAIL',
        review: 'VERDICT: FAIL',
      };
      return {
        output: outputs[req.stage] ?? 'ok',
        tokensIn: 1,
        tokensOut: 1,
        wallMs: 1,
        promptHash: 'h',
        promptSource: 's',
      };
    });
    const result = await prLanding({
      taskId: 'landing-o-r-13',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#13',
      agentCreated: false,
      headBranch: 'feature/x',
      config: { ...baseConfig, autoMerge: 'label' },
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.phase).toBe('done');
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(implementCalls).toBe(1);
  });
});
