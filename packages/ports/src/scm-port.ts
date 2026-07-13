import type { PrFeedback } from '@agentops/contracts';

export interface OpenPrRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface OpenPrResult {
  prRef: string;
  url: string;
}

export interface ScmPort {
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  push(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  readFile(repo: string, path: string): Promise<string | null>;
}
