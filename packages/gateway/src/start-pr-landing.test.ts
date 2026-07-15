import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { startOrSignalPrLanding } from './start-pr-landing';

describe('startOrSignalPrLanding', () => {
  const config = {
    stages: {},
    routing: {},
    brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 1, maxBabysitRounds: 1 },
  };

  it('starts a new enrollment workflow', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = { workflow: { start, getHandle: vi.fn() } } as never;
    const result = await startOrSignalPrLanding(client, 'q', 'p', {
      kind: 'enroll', repo: 'o/r', prRef: 'o/r#7', headBranch: 'feature/x', labels: ['automerge'], managed: false,
    }, config);
    expect(result.started).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it('signals instead of duplicating an already-running enrollment', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockRejectedValue(new WorkflowExecutionAlreadyStartedError('running', 'o/r#7', 'run'));
    const client = { workflow: { start, getHandle: vi.fn().mockReturnValue({ signal }) } } as never;
    const result = await startOrSignalPrLanding(client, 'q', 'p', {
      kind: 'enroll', repo: 'o/r', prRef: 'o/r#7', headBranch: 'feature/x', labels: ['automerge'], managed: false,
    }, config);
    expect(result.started).toBe(false);
    expect(signal).toHaveBeenCalledOnce();
  });

  it('wake events are signal-only and pass agentCreated false only on enroll starts', async () => {
    const start = vi.fn();
    const signal = vi.fn().mockResolvedValue(undefined);
    const client = { workflow: { start, getHandle: vi.fn().mockReturnValue({ signal }) } } as never;
    await startOrSignalPrLanding(client, 'q', 'p', {
      kind: 'wake', repo: 'o/r', prRef: 'o/r#7', headBranch: 'feature/x', labels: [], managed: true,
    }, config);
    expect(start).not.toHaveBeenCalled();
    expect(signal).toHaveBeenCalledOnce();
  });
});