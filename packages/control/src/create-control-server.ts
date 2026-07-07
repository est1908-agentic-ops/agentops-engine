import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import {
  PlatformAgentResultSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from '@agentops/contracts';
import { platform } from '@agentops/workflows';
import { matchPath } from './route';
import { resolveStaticFile } from './serve-static';

export interface ControlDeps {
  client: Client;
  taskQueue: string;
  namespace: string;
  temporalUiBaseUrl: string;
  registry: string[];
  uiDistPath?: string;
}

interface HandlerResponse {
  status: number;
  body?: unknown;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function memoPrompt(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.prompt === 'string' ? memo.prompt : undefined;
}

async function handleStartRun(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }

  const parsed = StartRunRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }

  const { prompt, hintRepos, workflowId: requestedWorkflowId } = parsed.data;
  const workflowId = requestedWorkflowId ?? `platform-${randomUUID()}`;

  try {
    const handle = await deps.client.workflow.start(platform, {
      taskQueue: deps.taskQueue,
      workflowId,
      args: [{ prompt, hintRepos }],
      memo: { prompt },
    });
    return {
      status: 202,
      body: StartRunResponseSchema.parse({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId }),
    };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { status: 409, body: { error: `a run with workflowId "${workflowId}" already exists` } };
    }
    throw err;
  }
}

async function handleListRuns(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
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
  for await (const execution of deps.client.workflow.list({ query: 'WorkflowType="platform"' })) {
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

async function handleGetRun(deps: ControlDeps, workflowId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle<typeof platform>(workflowId);

  let description;
  try {
    description = await handle.describe();
  } catch {
    return { status: 404, body: { error: `no run found with workflowId "${workflowId}"` } };
  }

  const status = description.status.name;
  const prompt = memoPrompt(description.memo as Record<string, unknown> | undefined);
  const temporalUrl = `${deps.temporalUiBaseUrl}/namespaces/${deps.namespace}/workflows/${workflowId}/${description.runId}/history`;
  const base = { workflowId, runId: description.runId, status, prompt, temporalUrl };

  if (status === 'COMPLETED') {
    try {
      const result = await handle.result();
      const parsedResult = PlatformAgentResultSchema.safeParse(result);
      if (!parsedResult.success) {
        return {
          status: 200,
          body: RunDetailSchema.parse({ ...base, error: 'run completed but its result did not match the expected shape' }),
        };
      }
      return { status: 200, body: RunDetailSchema.parse({ ...base, result: parsedResult.data }) };
    } catch (err) {
      return {
        status: 200,
        body: RunDetailSchema.parse({ ...base, error: err instanceof Error ? err.message : 'failed to fetch workflow result' }),
      };
    }
  }

  if (status === 'RUNNING') {
    return { status: 200, body: RunDetailSchema.parse(base) };
  }

  return { status: 200, body: RunDetailSchema.parse({ ...base, error: `workflow ended with status ${status}` }) };
}

function handleListRepos(deps: ControlDeps): HandlerResponse {
  return { status: 200, body: RepoListResponseSchema.parse({ repos: deps.registry }) };
}

async function dispatch(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse | undefined> {
  const url = new URL(req.url ?? '/', 'http://control.local');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/healthz') {
    return { status: 200 };
  }
  if (req.method === 'POST' && pathname === '/api/platform/runs') {
    return handleStartRun(deps, req);
  }
  if (req.method === 'GET' && pathname === '/api/platform/runs') {
    return handleListRuns(deps, url);
  }
  const runMatch = matchPath('/api/platform/runs/:workflowId', pathname);
  if (req.method === 'GET' && runMatch) {
    return handleGetRun(deps, runMatch.params.workflowId);
  }
  if (req.method === 'GET' && pathname === '/api/registry/repos') {
    return handleListRepos(deps);
  }
  return undefined;
}

async function handleRequest(deps: ControlDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const result = await dispatch(deps, req);
    if (result) {
      if (result.body === undefined) {
        res.writeHead(result.status).end();
      } else {
        res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
      }
      return;
    }

    if (req.method === 'GET' && deps.uiDistPath) {
      const url = new URL(req.url ?? '/', 'http://control.local');
      const file = await resolveStaticFile(deps.uiDistPath, url.pathname);
      if (file) {
        res.writeHead(200, { 'content-type': file.contentType }).end(file.body);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error('control: unhandled error', err);
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
  }
}

export function createControlServer(deps: ControlDeps): Server {
  return createServer((req, res) => {
    void handleRequest(deps, req, res);
  });
}
