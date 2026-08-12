import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { TaskInput } from '@agentops/contracts';

const {
  handlers,
  logMock,
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
  ActivityFailure,
  ApplicationFailure,
} = vi.hoisted(() => {
  class ActivityFailure extends Error {
    cause?: unknown;
    constructor(message?: string) {
      super(message);
      this.name = 'ActivityFailure';
    }
  }

  class ApplicationFailure extends Error {
    type = '';
    constructor(message?: string, type?: string) {
      super(message);
      this.name = 'ApplicationFailure';
      if (type) this.type = type;
    }
  }
  const handlers = new Map<string, () => void>();
  const logMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const runAgentFn = vi.fn().mockImplementation(async (req: { stage: string }) => {
    const outputs: Record<string, string> = {
      context: 'ctx',
      design: 'design',
      plan: 'plan',
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
  return {
    handlers,
    logMock,
    labelIssue: vi.fn().mockResolvedValue(undefined),
    unlabelIssue: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue({ ref: 'o/r#5', title: 'fix', body: '', labels: [] }),
    prepareWorkspace: vi
      .fn()
      .mockResolvedValue({ workspaceRef: 'ws', branch: 'br', baseBranch: 'main' }),
    openPr: vi.fn().mockResolvedValue({ prRef: 'pr-1', url: 'http://pr' }),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    getPrFeedback: vi
      .fn()
      .mockResolvedValue({ ciStatus: 'green', unresolvedThreads: 0, comments: [] }),
    getPrSnapshot: vi.fn().mockResolvedValue({
      prRef: 'pr-1',
      headSha: 'abc',
      headRepo: 'o/r',
      headBranch: 'br',
      checkoutRef: 'refs/pull/1/head',
      labels: ['agentops:managed'],
      state: 'open',
      draft: false,
      mergeable: true,
      mergedHeadSha: null,
      ciStatus: 'green',
      unresolvedThreads: 0,
      comments: [],
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
    ActivityFailure,
    ApplicationFailure,
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
  defineSignal: vi.fn((name: string) => name),
  setHandler: vi.fn((sig: string, handler: () => void) => {
    handlers.set(sig, handler);
  }),
  log: logMock,
  patched,
  startChild,
  trace: { getActiveSpan: () => ({ setAttributes: vi.fn() }) },
  ActivityFailure,
  ApplicationFailure,
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
    vi.mocked(getIssue).mockResolvedValueOnce({
      ref: 'o/r#5',
      title: 'fix',
      body: '',
      labels: ['agentops', 'bug'],
    });
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
    handlers.clear();
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
    expect(startChild).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        workflowId: 'pr-landing-pr-1',
        args: [
          expect.objectContaining({
            agentCreated: true,
            workspace: { workspaceRef: 'ws', branch: 'br', validatedHeadSha: 'abc' },
          }),
        ],
      }),
    );
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(result.landingOutcome).toBe('merged');
    expect(result.status).toBe('done');
  });
});

describe('devCycle child-signal forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    logMock.warn.mockClear();
    vi.mocked(patched).mockReturnValue(true);
  });

  it('cancel forwarded to an already-closed child does not reject', async () => {
    const resultDeferred: { resolve?: (val: { outcome: 'merged' }) => void } = {};
    const resultPromise = new Promise<{ outcome: 'merged' }>((resolve) => {
      resultDeferred.resolve = resolve;
    });

    vi.mocked(startChild).mockResolvedValue({
      result: vi.fn(() => resultPromise),
      signal: vi.fn().mockRejectedValue(new Error('child already completed')),
    });

    const unhandledRejections: unknown[] = [];
    const originalHandler = process.listeners('unhandledRejection')[0];
    process.on('unhandledRejection', (reason) => {
      unhandledRejections.push(reason);
    });

    try {
      const devCyclePromise = devCycle({
        taskId: 't',
        project: 'p',
        repo: 'o/r',
        issueRef: 'o/r#5',
        goal: 'fix',
        config,
      });

      // Let the workflow run to the point where landingChild is set
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }

      const cancelHandler = handlers.get('cancel');
      expect(cancelHandler).toBeDefined();
      cancelHandler?.();

      // Let the signal rejection be handled
      await Promise.resolve();

      resultDeferred.resolve?.({ outcome: 'merged' });
      const result = await devCyclePromise;

      expect(result.landingOutcome).toBe('merged');
      expect(result.status).toBe('done');
      expect(unhandledRejections).toHaveLength(0);
      expect(logMock.warn).toHaveBeenCalledWith(
        'failed to forward signal to prLanding child',
        expect.objectContaining({
          signalName: 'cancel',
        }),
      );
    } finally {
      process.removeAllListeners('unhandledRejection');
      if (originalHandler) {
        process.on('unhandledRejection', originalHandler);
      }
    }
  });

  it('resume forwarded to an already-closed child does not reject', async () => {
    const resultDeferred: { resolve?: (val: { outcome: 'merged' }) => void } = {};
    const resultPromise = new Promise<{ outcome: 'merged' }>((resolve) => {
      resultDeferred.resolve = resolve;
    });

    vi.mocked(startChild).mockResolvedValue({
      result: vi.fn(() => resultPromise),
      signal: vi.fn().mockRejectedValue(new Error('child already completed')),
    });

    const unhandledRejections: unknown[] = [];
    const originalHandler = process.listeners('unhandledRejection')[0];
    process.on('unhandledRejection', (reason) => {
      unhandledRejections.push(reason);
    });

    try {
      const devCyclePromise = devCycle({
        taskId: 't',
        project: 'p',
        repo: 'o/r',
        issueRef: 'o/r#5',
        goal: 'fix',
        config,
      });

      // Let the workflow run to the point where landingChild is set
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }

      const resumeHandler = handlers.get('resume');
      expect(resumeHandler).toBeDefined();
      resumeHandler?.();

      // Let the signal rejection be handled
      await Promise.resolve();

      resultDeferred.resolve?.({ outcome: 'merged' });
      const result = await devCyclePromise;

      expect(result.landingOutcome).toBe('merged');
      expect(result.status).toBe('done');
      expect(unhandledRejections).toHaveLength(0);
      expect(logMock.warn).toHaveBeenCalledWith(
        'failed to forward signal to prLanding child',
        expect.objectContaining({
          signalName: 'resume',
        }),
      );
    } finally {
      process.removeAllListeners('unhandledRejection');
      if (originalHandler) {
        process.on('unhandledRejection', originalHandler);
      }
    }
  });
});

describe('devCycle git push permission error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    vi.mocked(patched).mockReturnValue(false);
  });

  it('rethrows non-permission push errors without blocking', async () => {
    const genericError = new Error('git push failed');
    vi.mocked(pushBranch).mockRejectedValueOnce(genericError);

    const devCyclePromise = devCycle({
      taskId: 't',
      project: 'p',
      repo: 'o/r',
      issueRef: 'o/r#5',
      goal: 'fix',
      config,
    });

    // The workflow should fail with the error, not convert it to a block
    await expect(devCyclePromise).rejects.toThrow('git push failed');
  });
});
