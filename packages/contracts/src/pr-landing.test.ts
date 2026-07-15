import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_DISABLE_LABEL,
  AUTO_MERGE_LABEL,
  MergePrResultSchema,
  PrLandingInputSchema,
  PrLandingStateSchema,
  PrSnapshotSchema,
} from './pr-landing';

describe('PR landing contracts', () => {
  it('uses stable machine labels', () => {
    expect(AUTO_MERGE_LABEL).toBe('automerge');
    expect(AUTO_MERGE_DISABLE_LABEL).toBe('automerge:disable');
  });

  it('accepts child handoff and standalone inputs', () => {
    const base = { taskId: 'landing-o-r-7', project: 'p', repo: 'o/r', prRef: 'o/r#7', agentCreated: true };
    expect(PrLandingInputSchema.safeParse({ ...base, workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' } }).success).toBe(true);
    expect(PrLandingInputSchema.safeParse({ ...base, agentCreated: false, headBranch: 'feature/x' }).success).toBe(true);
  });

  it('requires exact typed snapshot and merge results', () => {
    expect(PrSnapshotSchema.parse({
      prRef: 'o/r#7', headSha: 'abc', headRepo: 'o/r', headBranch: 'feature/x', checkoutRef: 'refs/pull/7/head', labels: ['automerge'],
      state: 'open', draft: false, mergeable: true, mergedHeadSha: null,
      ciStatus: 'green', unresolvedThreads: 0, comments: [],
    }).headSha).toBe('abc');
    expect(MergePrResultSchema.parse({ kind: 'head-changed' }).kind).toBe('head-changed');
    expect(MergePrResultSchema.parse({ kind: 'merged', headSha: 'abc', mergeCommitSha: 'def' }).kind).toBe('merged');
  });

  it('represents manual and merged terminal outcomes', () => {
    const base = {
      taskId: 'landing-o-r-7', project: 'p', repo: 'o/r', phase: 'done', outcome: 'merge-ready-manual', blockReason: null,
      prRef: 'o/r#7', agentCreated: true, autoMergeMode: 'label', mergeResult: null,
      workspaceRef: '/ws/t', branch: 'feature/x', currentHeadSha: 'abc',
      validatedHeadSha: 'abc', implementAttempts: 0, iterations: 0, cumulativeTokens: 0, babysitRounds: 0,
    };
    expect(PrLandingStateSchema.parse(base).outcome).toBe('merge-ready-manual');
    expect(PrLandingStateSchema.parse({ ...base, outcome: 'merged' }).outcome).toBe('merged');
  });
});