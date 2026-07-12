import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, resolveTier } from './resolve-tier';
import type { ModelRef } from '@agentops/contracts';

describe('resolveTier', () => {
  it('returns the global default tier entries when no project-local tier is defined', () => {
    const result = resolveTier(undefined, 'smart');
    expect(result).toEqual(DEFAULT_TIERS.smart);
  });

  it('project-local tier wins over a same-named global tier', () => {
    const projectLocal: Record<string, ModelRef[]> = {
      smart: [{ backend: 'pi', model: 'zai/glm-5.2' }],
    };
    const result = resolveTier(projectLocal, 'smart');
    expect(result).toEqual([{ backend: 'pi', model: 'zai/glm-5.2' }]);
    expect(result).not.toEqual(DEFAULT_TIERS.smart);
  });

  it('global fills in when project-local does not define the requested tier', () => {
    const projectLocal: Record<string, ModelRef[]> = {
      review: [{ backend: 'claude', model: 'opus' }],
    };
    const result = resolveTier(projectLocal, 'implementation');
    expect(result).toEqual(DEFAULT_TIERS.implementation);
  });

  it('applies effort override to every entry when provided', () => {
    const result = resolveTier(undefined, 'smart', 'low');
    expect(result.every((entry) => entry.effort === 'low')).toBe(true);
  });

  it('preserves entry effort when no override is provided', () => {
    const result = resolveTier(undefined, 'implementation');
    // The third default entry (zai/glm-5.2) ships with effort 'low'; the
    // others have their own or none. Just assert the override isn't applied.
    expect(result[0]?.effort).not.toBe('low');
  });

  it('throws a clear error when the tier is found in neither project-local nor global', () => {
    expect(() => resolveTier(undefined, 'nonexistent')).toThrow(/nonexistent/);
  });
});
