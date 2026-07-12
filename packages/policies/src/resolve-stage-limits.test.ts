import { describe, expect, it } from 'vitest';
import { parseProjectConfig } from '@agentops/contracts';
import { resolveStageLimits } from './resolve-stage-limits';

describe('resolveStageLimits', () => {
  it('falls back to the global defaults when a stage has no override', () => {
    const config = parseProjectConfig({});
    expect(resolveStageLimits(config, 'context')).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 1_800_000 });
  });

  it('gives full_verify a larger idle default than the global one (its verify suite goes quiet for minutes)', () => {
    const config = parseProjectConfig({});
    expect(resolveStageLimits(config, 'full_verify')).toEqual({ idleTimeoutMs: 900_000, timeoutMs: 1_800_000 });
  });

  it('lets a project override full_verify idle back down below the verify default', () => {
    const config = parseProjectConfig({ timeouts: { full_verify: { idleTimeoutMs: 120_000 } } });
    expect(resolveStageLimits(config, 'full_verify')).toEqual({ idleTimeoutMs: 120_000, timeoutMs: 1_800_000 });
  });

  it('uses a stage-specific idleTimeoutMs override, defaulting timeoutMs', () => {
    const config = parseProjectConfig({ timeouts: { context: { idleTimeoutMs: 600_000 } } });
    expect(resolveStageLimits(config, 'context')).toEqual({ idleTimeoutMs: 600_000, timeoutMs: 1_800_000 });
  });

  it('uses a stage-specific timeoutMs override, defaulting idleTimeoutMs', () => {
    const config = parseProjectConfig({ timeouts: { implement: { timeoutMs: 3_600_000 } } });
    expect(resolveStageLimits(config, 'implement')).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 3_600_000 });
  });

  it('leaves stages without an override at the defaults, even when other stages are overridden', () => {
    const config = parseProjectConfig({ timeouts: { implement: { timeoutMs: 3_600_000 } } });
    expect(resolveStageLimits(config, 'review')).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 1_800_000 });
  });
});
