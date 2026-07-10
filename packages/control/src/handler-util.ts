import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { RunListItemSchema } from '@agentops/contracts';
import type { ControlDeps } from './create-control-server';

export interface HandlerResponse {
  status: number;
  body?: unknown;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
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
    });
    req.on('error', reject);
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
