import { describe, expect, it } from 'vitest';
import { InMemoryStageResultStore } from './stage-result-store';

describe('InMemoryStageResultStore', () => {
  it('filters recorded results by taskId', () => {
    const store = new InMemoryStageResultStore();
    store.record({ taskId: 't1', stage: 'context', source: 'agent', contentHash: 'a', tokens: 1, outcome: 'pass' });
    store.record({ taskId: 't2', stage: 'context', source: 'agent', contentHash: 'b', tokens: 1, outcome: 'pass' });
    expect(store.forTask('t1')).toHaveLength(1);
    expect(store.forTask('t1')[0].contentHash).toBe('a');
  });
});
