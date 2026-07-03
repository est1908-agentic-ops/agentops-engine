import type { PrFeedback } from '@agentops/contracts';
import type { OpenPrRequest, OpenPrResult, ScmPort } from '../scm-port';

export class MemoryScmPort implements ScmPort {
  private readonly feedbackQueues = new Map<string, PrFeedback[]>();
  private readonly openedPrs: OpenPrRequest[] = [];
  private readonly files = new Map<string, string>();
  private prCounter = 0;

  scriptFeedback(prRef: string, sequence: PrFeedback[]): void {
    this.feedbackQueues.set(prRef, [...sequence]);
  }

  seedFile(repo: string, path: string, content: string): void {
    this.files.set(`${repo}:${path}`, content);
  }

  async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
    this.prCounter += 1;
    const prRef = `pr-${this.prCounter}`;
    this.openedPrs.push(req);
    return { prRef, url: `https://memory.local/${req.repo}/${prRef}` };
  }

  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    const queue = this.feedbackQueues.get(prRef);
    if (!queue || queue.length === 0) {
      throw new Error(`MemoryScmPort: no scripted feedback for "${prRef}"`);
    }
    return queue.length > 1 ? queue.shift()! : queue[0];
  }

  async push(_workspaceRef: string, _branch: string, _contentHash: string): Promise<void> {}

  async readFile(repo: string, path: string): Promise<string | null> {
    return this.files.get(`${repo}:${path}`) ?? null;
  }

  getOpenedPrs(): OpenPrRequest[] {
    return [...this.openedPrs];
  }
}
