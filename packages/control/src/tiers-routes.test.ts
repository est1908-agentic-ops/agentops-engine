import { describe, expect, it } from 'vitest';
import { validateTiersTable } from './tiers-routes';

const ok = (backend = 'claude', model = 'opus') => ({ backend, model });

describe('validateTiersTable', () => {
  it('accepts a well-formed table', () => {
    expect(validateTiersTable({ smart: [ok(), { backend: 'pi', model: 'glm' }] })).toBeNull();
  });

  it('rejects an empty table', () => {
    expect(validateTiersTable({})).toMatch(/at least one tier/);
  });

  it('rejects an empty tier (no primary)', () => {
    expect(validateTiersTable({ smart: [] })).toMatch(/no entries/);
  });

  it('rejects an invalid backend', () => {
    expect(validateTiersTable({ smart: [{ backend: 'grok', model: 'x' }] })).toMatch(/invalid backend "grok"/);
  });

  it('rejects an invalid effort', () => {
    expect(validateTiersTable({ smart: [{ backend: 'claude', model: 'opus', effort: 'turbo' }] })).toMatch(
      /invalid effort "turbo"/,
    );
  });

  it('accepts a valid effort', () => {
    expect(validateTiersTable({ smart: [{ backend: 'claude', model: 'opus', effort: 'max' }] })).toBeNull();
  });

  it('rejects a duplicate (backend, model) within a tier', () => {
    expect(
      validateTiersTable({ smart: [ok('claude', 'opus'), ok('claude', 'opus')] }),
    ).toMatch(/duplicate entry claude\/opus/);
  });

  it('allows the same model on different backends within a tier', () => {
    expect(validateTiersTable({ smart: [ok('claude', 'opus'), ok('pi', 'opus')] })).toBeNull();
  });
});
