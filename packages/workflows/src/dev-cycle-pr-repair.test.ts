import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DevCyclePrRepairInput } from '@agentops/contracts';

let cancelHandler: (() => void) | null = null;

const {
  prepareWorkspace,
  pushBranch,
  getPrFeedback,
  cleanupWorkspace,
  recordStageResult,
  recordRunStats,
  resolveRepoConfig,
  runAgent,
} = vi.hoisted(() => {
  const runAgentFn = vi.fn().mockImplementation(async (req: { stage: string }) => {
    const outputs: Record<string, string> = {
      implement: 'diff',
      full_verify: 'FULL: PASS',
      review: 'VERDICT: PASS',
    };
    return { output: outputs[req.stage] ?? 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1, promptHash: 'h', promptSource: 's' };
  });
  return {
    prepareWorkspace: vi.fn().mockResolvedValue({ workspaceRef: 'ws', branch: 'br', baseBranch: 'main' }),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    getPrFeedback: vi.fn().mockResolvedValue({ ciStatus: 'pending', unresolvedThreads: 0, comments: [] }),
    cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
    recordStageResult: vi.fn().mockResolvedValue(undefined),
    recordRunStats: vi.fn().mockResolvedValue(undefined),
    resolveRepoConfig: vi.fn().mockResolvedValue({ config: null }),
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
      pushBranch,
      getPrFeedback,
      cleanupWorkspace,
      recordStageResult,
      recordRunStats,
      resolveRepoConfig,
    };
  },
  condition: vi.fn(async (cb: () => boolean) => {
    // When called at the babysit brake, invoke the cancel handler and then resolve
    if (cancelHandler) {
      cancelHandler();
      cancelHandler = null;
    }
    return cb();
  }),
  sleep: vi.fn().mockResolvedValue(undefined),
  defineQuery: vi.fn((name) => name),
  defineSignal: vi.fn((name) => name),
  setHandler: vi.fn((signal, handler) => {
    if (signal === 'cancel') {
      cancelHandler = handler;
    }
  }),
  trace: { getActiveSpan: () => ({ setAttributes: vi.fn() }) },
  ActivityFailure: class ActivityFailure extends Error {},
  ApplicationFailure: class ApplicationFailure extends Error {
    type = '';
  },
}));

import { devCyclePrRepair } from './dev-cycle-pr-repair';

const config = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 5, maxIterations: 20, maxTokens: 1000000, maxBabysitRounds: 10 },
};

describe('devCyclePrRepair babysit brake cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelHandler = null;
  });

  it('terminates with status:failed when cancel is sent at babysit brake', async () => {
    const input: DevCyclePrRepairInput = {
      taskId: 'task-123',
      project: 'test-project',
      repo: 'owner/repo',
      prRef: 'owner/repo#42',
      config,
    };

    const result = await devCyclePrRepair(input);

    // Assertions: workflow should have terminated (not hung)
    expect(result.status).toBe('failed');
    expect(result.stage).toBe('failed');
    expect(cleanupWorkspace).toHaveBeenCalledWith('ws', 'owner/repo');
  });
});
