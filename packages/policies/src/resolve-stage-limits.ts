import type { ProjectConfig, Timeouts } from '@agentops/contracts';
import { DEFAULT_BACKSTOP_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_VERIFY_IDLE_TIMEOUT_MS } from '@agentops/contracts';

export interface StageLimits {
  idleTimeoutMs: number;
  timeoutMs: number;
}

// Stages whose agent legitimately goes quiet for minutes at a time while a
// single long tool call runs get a larger idle default than the 5-minute
// global one. full_verify runs the project's verify commands (a full test
// suite / build); the agent kicks one off and produces no streamed output until
// it finishes, which routinely exceeds 5 minutes and would otherwise trip the
// idle-timeout on every attempt. A project can still override via
// timeouts.<stage>.idleTimeoutMs. See prompt-broccoli-cachefix-verify-1.
const STAGE_IDLE_DEFAULTS: Partial<Record<keyof Timeouts, number>> = {
  full_verify: DEFAULT_VERIFY_IDLE_TIMEOUT_MS,
};

export function resolveStageLimits(config: ProjectConfig, stage: keyof Timeouts): StageLimits {
  const override = config.timeouts?.[stage];
  return {
    idleTimeoutMs: override?.idleTimeoutMs ?? STAGE_IDLE_DEFAULTS[stage] ?? DEFAULT_IDLE_TIMEOUT_MS,
    timeoutMs: override?.timeoutMs ?? DEFAULT_BACKSTOP_TIMEOUT_MS,
  };
}
