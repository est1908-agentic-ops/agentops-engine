import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from './memory-scm';

describe('MemoryScmPort', () => {
  it('opens a PR and returns an incrementing prRef', async () => {
    const scm = new MemoryScmPort();
    const first = await scm.openPr({ repo: 'demo/repo', branch: 'agentops/t1', title: 't1', body: 'b' });
    const second = await scm.openPr({ repo: 'demo/repo', branch: 'agentops/t2', title: 't2', body: 'b' });
    expect(first.prRef).toBe('pr-1');
    expect(second.prRef).toBe('pr-2');
    expect(scm.getOpenedPrs()).toHaveLength(2);
  });

  it('plays back a scripted feedback sequence in order', async () => {
    const scm = new MemoryScmPort();
    scm.scriptFeedback('pr-1', [
      { ciStatus: 'failed', unresolvedThreads: 1, comments: [{ id: 'c1', body: 'fix', resolved: false }] },
      { ciStatus: 'green', unresolvedThreads: 0, comments: [] },
    ]);
    const firstPoll = await scm.getPrFeedback('pr-1');
    const secondPoll = await scm.getPrFeedback('pr-1');
    expect(firstPoll.ciStatus).toBe('failed');
    expect(secondPoll.ciStatus).toBe('green');
  });

  it('repeats the last scripted feedback once the sequence is exhausted', async () => {
    const scm = new MemoryScmPort();
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    await scm.getPrFeedback('pr-1');
    const secondPoll = await scm.getPrFeedback('pr-1');
    expect(secondPoll.ciStatus).toBe('green');
  });

  it('throws when polling feedback for a PR with no script', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.getPrFeedback('pr-unknown')).rejects.toThrow();
  });

  it('readFile returns null for a file that was never seeded', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.readFile('demo/repo', 'README.md')).resolves.toBeNull();
  });

  it('readFile returns seeded content', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('demo/repo', 'README.md', '# demo');
    await expect(scm.readFile('demo/repo', 'README.md')).resolves.toBe('# demo');
  });

  it('push accepts and ignores repo/workspaceRef (real git happens in the real adapter, not here)', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.push('demo/repo', '/some/workspace/path', 'branch-x', 'hash-x')).resolves.toBeUndefined();
  });

  it('scripts snapshots and merges at the exact expected head SHA', async () => {
    const scm = new MemoryScmPort();
    scm.scriptSnapshots('pr-1', [{
      prRef: 'pr-1', headSha: 'abc', headRepo: 'demo/repo', headBranch: 'feature/x', checkoutRef: 'refs/pull/1/head',
      labels: ['automerge'], state: 'open', draft: false, mergeable: true, mergedHeadSha: null,
      ciStatus: 'green', unresolvedThreads: 0, comments: [],
    }]);
    await expect(scm.mergePr({ prRef: 'pr-1', expectedHeadSha: 'abc' }))
      .resolves.toEqual({ kind: 'merged', headSha: 'abc', mergeCommitSha: 'merge-abc' });
    expect(scm.getOperations()).toContainEqual({ type: 'mergePr', prRef: 'pr-1', expectedHeadSha: 'abc' });
    await expect(scm.getPrSnapshot('pr-1')).resolves.toMatchObject({ state: 'merged', mergedHeadSha: 'abc' });
  });

  it('returns head-changed when the expected SHA does not match', async () => {
    const scm = new MemoryScmPort();
    scm.scriptSnapshots('pr-1', [{
      prRef: 'pr-1', headSha: 'abc', headRepo: 'demo/repo', headBranch: 'feature/x', checkoutRef: 'refs/pull/1/head',
      labels: [], state: 'open', draft: false, mergeable: true, mergedHeadSha: null,
      ciStatus: 'green', unresolvedThreads: 0, comments: [],
    }]);
    await expect(scm.mergePr({ prRef: 'pr-1', expectedHeadSha: 'def' }))
      .resolves.toEqual({ kind: 'head-changed' });
    expect(scm.getOperations()).toHaveLength(0);
  });
});
