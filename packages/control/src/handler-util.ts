import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { RunListItemSchema } from '@agentops/contracts';
import type { ControlDeps } from './create-control-server';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

export function isPayloadTooLarge(err: unknown): boolean {
  return err instanceof PayloadTooLargeError || (err as { name?: string })?.name === 'PayloadTooLargeError';
}

export interface HandlerResponse {
  status: number;
  body?: unknown;
}

export function readJsonBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const length = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(length) && length > maxBytes) {
        reject(new PayloadTooLargeError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      const reqWithOptionalRemoveListener = req as unknown as { removeListener?: (e: string, cb: (arg?: unknown) => void) => void };
      if (typeof reqWithOptionalRemoveListener.removeListener === 'function') {
        reqWithOptionalRemoveListener.removeListener('data', onData as (arg?: unknown) => void);
        reqWithOptionalRemoveListener.removeListener('end', onEnd as (arg?: unknown) => void);
        reqWithOptionalRemoveListener.removeListener('error', onError as (arg?: unknown) => void);
      }
    };

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new PayloadTooLargeError());
          const reqWithOptionalDestroy = req as unknown as { destroy?: () => void };
          if (typeof reqWithOptionalDestroy.destroy === 'function') {
            reqWithOptionalDestroy.destroy();
          }
        }
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (!settled) {
        settled = true;
        cleanup();
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      }
    };

    const onError = (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function memoPrompt(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.prompt === 'string' ? memo.prompt : undefined;
}

// One lister for every workflow type the console shows (platform, devCycle).
export async function listRunsByType(deps: ControlDeps, url: URL, workflowType: string): Promise<HandlerResponse> {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20;

  const executions: Array<{
    workflowId: string;
    runId: string;
    status: { name: string };
    startTime: Date;
    closeTime?: Date;
    memo?: Record<string, unknown>;
  }> = [];

  // Dev server visibility does not support ORDER BY — fetch matching runs and sort locally.
  for await (const execution of deps.client.workflow.list({ query: `WorkflowType="${workflowType}"` })) {
    executions.push(execution as (typeof executions)[number]);
  }

  executions.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  const items: unknown[] = [];
  for (const execution of executions.slice(0, limit)) {
    const prompt = memoPrompt(execution.memo);
    const parsed = RunListItemSchema.safeParse({
      workflowId: execution.workflowId,
      runId: execution.runId,
      status: execution.status.name,
      startTime: execution.startTime.toISOString(),
      closeTime: execution.closeTime?.toISOString(),
      promptSnippet: prompt ? truncate(prompt, 120) : undefined,
    });
    if (parsed.success) {
      items.push(parsed.data);
    }
  }
  return { status: 200, body: items };
}
