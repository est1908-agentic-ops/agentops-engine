import { describe, expect, it } from 'vitest';
import { InMemoryFiledFindingStore } from './filed-finding-store';

describe('InMemoryFiledFindingStore', () => {
  it('reserve returns { won: true } for a new fingerprint', async () => {
    const store = new InMemoryFiledFindingStore();

    const result = await store.reserve('proj1', 'fp1');

    expect(result).toEqual({ won: true, issueRef: '' });
  });

  it('reserve returns { won: false, issueRef: "" } for a pending peer', async () => {
    const store = new InMemoryFiledFindingStore();
    await store.reserve('proj1', 'fp1');

    const result = await store.reserve('proj1', 'fp1');

    expect(result).toEqual({ won: false, issueRef: '' });
  });

  it('reserve returns { won: false, issueRef } for a finalized row', async () => {
    const store = new InMemoryFiledFindingStore();
    await store.reserve('proj1', 'fp1');
    await store.finalize('proj1', 'fp1', 'issue-123');

    const result = await store.reserve('proj1', 'fp1');

    expect(result).toEqual({ won: false, issueRef: 'issue-123' });
  });

  it('finalize overwrites issueRef only if the row is pending', async () => {
    const store = new InMemoryFiledFindingStore();
    await store.reserve('proj1', 'fp1');

    await store.finalize('proj1', 'fp1', 'issue-123');
    const result = await store.reserve('proj1', 'fp1');

    expect(result.issueRef).toBe('issue-123');
  });

  it('release deletes only if the row is pending', async () => {
    const store = new InMemoryFiledFindingStore();
    await store.reserve('proj1', 'fp1');

    await store.release('proj1', 'fp1');
    const result = await store.reserve('proj1', 'fp1');

    expect(result.won).toBe(true);
  });

  it('release does not delete if the row is finalized', async () => {
    const store = new InMemoryFiledFindingStore();
    await store.reserve('proj1', 'fp1');
    await store.finalize('proj1', 'fp1', 'issue-123');

    await store.release('proj1', 'fp1');
    const result = await store.reserve('proj1', 'fp1');

    expect(result).toEqual({ won: false, issueRef: 'issue-123' });
  });
});
