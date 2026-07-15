import type { MergePrRequest, MergePrResult, PrFeedback, PrSnapshot } from '@agentops/contracts';
import type { OpenPrRequest, OpenPrResult, ScmPort } from '../scm-port';

export interface ScmOperation {
  type: 'push' | 'openPr' | 'mergePr';
  branch?: string;
  prRef?: string;
  expectedHeadSha?: string;
}

function feedbackFromSnapshot(snapshot: PrSnapshot): PrFeedback {
  return {
    ciStatus: snapshot.ciStatus,
    unresolvedThreads: snapshot.unresolvedThreads,
    comments: snapshot.comments,
  };
}

function defaultSnapshot(prRef: string, branch: string, labels: string[] = []): PrSnapshot {
  const number = prRef.match(/#(\d+)$/)?.[1] ?? '1';
  return {
    prRef,
    headSha: `synthetic-${prRef}`,
    headRepo: prRef.replace(/#\d+$/, ''),
    headBranch: branch,
    checkoutRef: `refs/pull/${number}/head`,
    labels,
    state: 'open',
    draft: false,
    mergeable: true,
    mergedHeadSha: null,
    ciStatus: 'green',
    unresolvedThreads: 0,
    comments: [],
  };
}

export class MemoryScmPort implements ScmPort {
  private readonly feedbackQueues = new Map<string, PrFeedback[]>();
  private readonly snapshotQueues = new Map<string, PrSnapshot[]>();
  private readonly openedPrs: OpenPrRequest[] = [];
  private readonly files = new Map<string, string>();
  private readonly operations: ScmOperation[] = [];
  private readonly currentSnapshots = new Map<string, PrSnapshot>();
  private prCounter = 0;

  scriptFeedback(prRef: string, sequence: PrFeedback[]): void {
    this.feedbackQueues.set(prRef, [...sequence]);
  }

  scriptSnapshots(prRef: string, sequence: PrSnapshot[]): void {
    this.snapshotQueues.set(prRef, [...sequence]);
    if (sequence.length > 0) {
      this.currentSnapshots.set(prRef, { ...sequence[0] });
    }
  }

  seedFile(repo: string, path: string, content: string): void {
    this.files.set(`${repo}:${path}`, content);
  }

  async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
    this.operations.push({ type: 'openPr', branch: req.branch });
    this.prCounter += 1;
    const prRef = `pr-${this.prCounter}`;
    this.openedPrs.push(req);
    this.currentSnapshots.set(prRef, defaultSnapshot(prRef, req.branch, req.labels ?? []));
    return { prRef, url: `https://memory.local/${req.repo}/${prRef}` };
  }

  private nextSnapshot(prRef: string): PrSnapshot {
    const snapshotQueue = this.snapshotQueues.get(prRef);
    if (snapshotQueue && snapshotQueue.length > 0) {
      const snapshot = snapshotQueue.length > 1 ? snapshotQueue.shift()! : snapshotQueue[0];
      this.currentSnapshots.set(prRef, { ...snapshot });
      return snapshot;
    }

    const feedbackQueue = this.feedbackQueues.get(prRef);
    if (feedbackQueue && feedbackQueue.length > 0) {
      const feedback = feedbackQueue.length > 1 ? feedbackQueue.shift()! : feedbackQueue[0];
      const base = this.currentSnapshots.get(prRef) ?? defaultSnapshot(prRef, 'agentops/legacy');
      const snapshot = { ...base, ...feedback };
      this.currentSnapshots.set(prRef, snapshot);
      return snapshot;
    }

    const base = this.currentSnapshots.get(prRef);
    if (base) {
      return base;
    }

    throw new Error(`MemoryScmPort: no scripted snapshot or feedback for "${prRef}"`);
  }

  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    return feedbackFromSnapshot(await this.getPrSnapshot(prRef));
  }

  async getPrSnapshot(prRef: string): Promise<PrSnapshot> {
    return this.nextSnapshot(prRef);
  }

  async mergePr(req: MergePrRequest): Promise<MergePrResult> {
    const snapshot = this.currentSnapshots.get(req.prRef);
    if (!snapshot) {
      throw new Error(`MemoryScmPort: no snapshot for "${req.prRef}"`);
    }
    if (snapshot.headSha !== req.expectedHeadSha) {
      return { kind: 'head-changed' };
    }
    if (snapshot.state === 'merged') {
      return { kind: 'already-merged', headSha: req.expectedHeadSha };
    }
    this.operations.push({
      type: 'mergePr',
      prRef: req.prRef,
      expectedHeadSha: req.expectedHeadSha,
    });
    const merged: PrSnapshot = {
      ...snapshot,
      state: 'merged',
      mergedHeadSha: req.expectedHeadSha,
      mergeable: true,
    };
    this.currentSnapshots.set(req.prRef, merged);
    const queue = this.snapshotQueues.get(req.prRef);
    if (queue && queue.length > 0) {
      queue[0] = merged;
    }
    return {
      kind: 'merged',
      headSha: req.expectedHeadSha,
      mergeCommitSha: `merge-${req.expectedHeadSha}`,
    };
  }

  async push(
    _repo: string,
    _workspaceRef: string,
    branch: string,
    _contentHash: string,
  ): Promise<void> {
    this.operations.push({ type: 'push', branch });
  }

  async readFile(repo: string, path: string): Promise<string | null> {
    return this.files.get(`${repo}:${path}`) ?? null;
  }

  getOpenedPrs(): OpenPrRequest[] {
    return [...this.openedPrs];
  }

  getOperations(): ScmOperation[] {
    return [...this.operations];
  }
}
