import { describe, expect, it } from 'vitest';
import { nextRepairAction, type RepairState } from './next-repair-action';

const brakes = {
  maxImplementAttempts: 3,
  maxIterations: 6,
  maxTokens: 200_000,
  maxBabysitRounds: 5,
};

const baseState: RepairState = {
  implementAttempts: 1,
  iterations: 1,
  cumulativeTokens: 10,
  fullVerify: 'fail',
  review: 'unparseable',
  diffEmpty: false,
  brakes,
  hasEscalationModel: false,
};

describe('nextRepairAction', () => {
  it('continues when both full-verify and review pass', () => {
    const action = nextRepairAction({ ...baseState, fullVerify: 'pass', review: 'pass' });
    expect(action).toEqual({ kind: 'continue' });
  });

  it('requires BOTH verdicts to pass — full-verify pass alone is not enough', () => {
    const action = nextRepairAction({ ...baseState, fullVerify: 'pass', review: 'fail' });
    expect(action.kind).toBe('fix');
  });

  it('fixes (without escalation) on a non-final attempt', () => {
    const action = nextRepairAction(baseState);
    expect(action).toEqual({ kind: 'fix', useEscalationModel: false });
  });

  it('uses the escalation model on the final attempt when one is configured', () => {
    const action = nextRepairAction({
      ...baseState,
      implementAttempts: 2,
      hasEscalationModel: true,
    });
    expect(action).toEqual({ kind: 'fix', useEscalationModel: true });
  });

  it('does not escalate on the final attempt when no escalation model is configured', () => {
    const action = nextRepairAction({
      ...baseState,
      implementAttempts: 2,
      hasEscalationModel: false,
    });
    expect(action).toEqual({ kind: 'fix', useEscalationModel: false });
  });

  it('opens the PR anyway once attempts are exhausted with a non-empty diff', () => {
    const action = nextRepairAction({ ...baseState, implementAttempts: 3, diffEmpty: false });
    expect(action).toEqual({ kind: 'open-pr-exhausted' });
  });

  it('blocks on max-attempts when attempts are exhausted AND the diff is empty', () => {
    const action = nextRepairAction({ ...baseState, implementAttempts: 3, diffEmpty: true });
    expect(action).toEqual({ kind: 'block', reason: 'max-attempts' });
  });

  it('blocks on a tripped brake before considering exhaustion or escalation', () => {
    const action = nextRepairAction({
      ...baseState,
      implementAttempts: 3,
      cumulativeTokens: 200_000,
      diffEmpty: true,
    });
    expect(action).toEqual({ kind: 'block', reason: 'token-brake' });
  });
});
