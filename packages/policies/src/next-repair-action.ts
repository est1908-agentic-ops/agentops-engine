import type { BlockReason, Brakes, VerdictKind } from '@agentops/contracts';
import { evaluateBrakes } from './evaluate-brakes';

export type RepairAction =
  | { kind: 'continue' }
  | { kind: 'fix'; useEscalationModel: boolean }
  | { kind: 'open-pr-exhausted' }
  | { kind: 'block'; reason: BlockReason };

export interface RepairState {
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  fullVerify: VerdictKind;
  review: VerdictKind;
  diffEmpty: boolean;
  brakes: Brakes;
  hasEscalationModel: boolean;
}

export function nextRepairAction(state: RepairState): RepairAction {
  const brakeReason = evaluateBrakes(
    {
      implementAttempts: state.implementAttempts,
      iterations: state.iterations,
      cumulativeTokens: state.cumulativeTokens,
      babysitRounds: 0,
    },
    state.brakes,
  );
  if (brakeReason) {
    return { kind: 'block', reason: brakeReason };
  }

  const cleanPass = state.fullVerify === 'pass' && state.review === 'pass';
  if (cleanPass) {
    return { kind: 'continue' };
  }

  const attemptsExhausted = state.implementAttempts >= state.brakes.maxImplementAttempts;
  if (attemptsExhausted) {
    return state.diffEmpty ? { kind: 'block', reason: 'max-attempts' } : { kind: 'open-pr-exhausted' };
  }

  const isFinalAttempt = state.implementAttempts === state.brakes.maxImplementAttempts - 1;
  return { kind: 'fix', useEscalationModel: isFinalAttempt && state.hasEscalationModel };
}
