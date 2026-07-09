import { describe, expect, it } from 'vitest';
import { DevCycleStateSchema } from './dev-cycle-state';

const VALID = {
  taskId: 't-1',
  stage: 'context',
  status: 'running',
  blockReason: null,
  implementAttempts: 0,
  iterations: 0,
  cumulativeTokens: 0,
  babysitRounds: 0,
  prRef: null,
  workspaceRef: '',
  branch: '',
};

describe('DevCycleStateSchema', () => {
  it('accepts a fresh running state', () => {
    expect(DevCycleStateSchema.parse(VALID)).toEqual(VALID);
  });

  it('accepts the unregistered-repo fail-fast state', () => {
    const parsed = DevCycleStateSchema.parse({
      ...VALID,
      stage: 'failed',
      status: 'failed',
      blockReason: 'unregistered-repo',
    });
    expect(parsed.blockReason).toBe('unregistered-repo');
  });

  it('accepts a done state with a PR ref', () => {
    const parsed = DevCycleStateSchema.parse({ ...VALID, stage: 'done', status: 'done', prRef: 'pr-1' });
    expect(parsed.prRef).toBe('pr-1');
  });

  it('rejects an unknown stage', () => {
    expect(DevCycleStateSchema.safeParse({ ...VALID, stage: 'nope' }).success).toBe(false);
  });

  it('rejects a missing taskId', () => {
    const { taskId: _dropped, ...rest } = VALID;
    expect(DevCycleStateSchema.safeParse(rest).success).toBe(false);
  });
});
