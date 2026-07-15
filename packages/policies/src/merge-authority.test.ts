import { describe, expect, it } from 'vitest';
import type { AutoMergeMode } from '@agentops/contracts';
import { decideMergeAuthority } from './merge-authority';

describe('decideMergeAuthority', () => {
  const cases: Array<[AutoMergeMode, boolean, string[], 'merge' | 'manual']> = [
    ['disabled', true, [], 'manual'],
    ['disabled', true, ['automerge'], 'manual'],
    ['disabled', false, ['automerge'], 'manual'],
    ['label', true, [], 'manual'],
    ['label', true, ['automerge'], 'merge'],
    ['label', false, ['automerge'], 'merge'],
    ['all', true, [], 'merge'],
    ['all', false, [], 'manual'],
    ['all', false, ['automerge'], 'merge'],
    ['all', true, ['automerge:disable'], 'manual'],
    ['label', true, ['automerge', 'automerge:disable'], 'manual'],
  ];

  it.each(cases)('%s agentCreated=%s labels=%j -> %s', (mode, agentCreated, labels, expected) => {
    expect(decideMergeAuthority({ mode, agentCreated, labels })).toBe(expected);
  });
});