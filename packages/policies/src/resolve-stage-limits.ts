import type { ProjectConfig, Timeouts } from '@agentops/contracts';
import { DEFAULT_BACKSTOP_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from '@agentops/contracts';

export interface StageLimits {
  idleTimeoutMs: number;
  timeoutMs: number;
}

export function resolveStageLimits(config: ProjectConfig, stage: keyof Timeouts): StageLimits {
  const override = config.timeouts?.[stage];
  return {
    idleTimeoutMs: override?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    timeoutMs: override?.timeoutMs ?? DEFAULT_BACKSTOP_TIMEOUT_MS,
  };
}
