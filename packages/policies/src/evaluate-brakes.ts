import type { BlockReason, Brakes } from '@agentops/contracts';

export interface BrakeCounters {
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  babysitRounds: number;
}

export function evaluateBrakes(counters: BrakeCounters, brakes: Brakes): BlockReason | null {
  if (counters.cumulativeTokens >= brakes.maxTokens) {
    return 'token-brake';
  }
  if (counters.iterations >= brakes.maxIterations) {
    return 'iteration-brake';
  }
  if (counters.babysitRounds >= brakes.maxBabysitRounds) {
    return 'babysit-brake';
  }
  return null;
}
