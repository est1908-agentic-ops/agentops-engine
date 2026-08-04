import { describe, expectTypeOf, it } from 'vitest';
import type { ResolvedProjectEntry } from './resolved-project-entry';

type IsRequired<T, K extends keyof T> = Pick<T, K> extends Required<Pick<T, K>> ? true : false;

describe('ResolvedProjectEntry', () => {
  it('requires readRepositories on both resolved tracker variants', () => {
    expectTypeOf<
      IsRequired<Extract<ResolvedProjectEntry, { trackerType: 'github' }>, 'readRepositories'>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      IsRequired<Extract<ResolvedProjectEntry, { trackerType: 'linear' }>, 'readRepositories'>
    >().toEqualTypeOf<true>();
  });

  it('does not require Linear webhook trigger configuration', () => {
    expectTypeOf<
      IsRequired<Extract<ResolvedProjectEntry, { trackerType: 'linear' }>, 'linearTriggerLabelId'>
    >().toEqualTypeOf<false>();
  });
});
