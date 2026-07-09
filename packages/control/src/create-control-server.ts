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
  CreateManagedProjectRequestSchema,
  UpdateManagedProjectRequestSchema,
} from '@agentops/contracts';
import type { PostgresManagedProjectStore } from '@agentops/activities';
import { platform } from '@agentops/workflows';
import { matchPath } from './route';
import { resolveStaticFile } from './serve-static';

export interface ControlDeps {
  client: Client;
  taskQueue: string;
  namespace: string;
  temporalUiBaseUrl: string;
  uiDistPath?: string;
  // Managed-project CRUD (design §7). The store encrypts tokens internally
  // with `projectCredentialPublicKey`; control holds ONLY the public key and
  // the store, so it can write credentials it cannot read (design §5). All
  // five routes are gated behind `projectCrudAuthToken` (a bearer token);
  // with any of these three unset the routes return 503. Issue #4 (Traefik
  // basic-auth) is still required before the control ingress goes public.
  managedProjectStore?: PostgresManagedProjectStore;
  projectCredentialPublicKey?: string;
  projectCrudAuthToken?: string;
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

// The "known repos" hint list is now just the managed-project list's repos
// -- the static PROJECT_REGISTRY_JSON registry this used to read no longer
// exists (see the Linear trigger design doc's DB-only addendum). No store
// configured means no hints, same as before.
async function handleListRepos(deps: ControlDeps): Promise<HandlerResponse> {
  const repos = deps.managedProjectStore ? (await deps.managedProjectStore.list()).map((project) => project.repo) : [];
  return { status: 200, body: RepoListResponseSchema.parse({ repos }) };
}

function isProjectCrudEnabled(deps: ControlDeps): boolean {
  return Boolean(deps.managedProjectStore && deps.projectCredentialPublicKey && deps.projectCrudAuthToken);
}

function authorizeProjectCrud(deps: ControlDeps, req: IncomingMessage): boolean {
  // X-Control-Crud-Token (not Authorization): Traefik basic-auth on the control
  // ingress consumes the Authorization header, so the CRUD bearer token uses a
  // custom header to avoid collision. Works with or without basic-auth in front.
  return req.headers['x-control-crud-token'] === deps.projectCrudAuthToken;
}

async function handleListProjects(deps: ControlDeps): Promise<HandlerResponse> {
  return { status: 200, body: await deps.managedProjectStore!.list() };
}

async function handleGetProject(deps: ControlDeps, repo: string): Promise<HandlerResponse> {
  const project = await deps.managedProjectStore!.get(repo);
  if (!project) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  return { status: 200, body: project };
}

async function handleCreateProject(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = CreateManagedProjectRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }
  const { project, repo, token, config, trackerType, linearTeamKey, linearTriggerLabelId, linearToken } = parsed.data;
  if (await deps.managedProjectStore!.get(repo)) {
    return { status: 409, body: { error: `a managed project for repo "${repo}" already exists` } };
  }
  if (await deps.managedProjectStore!.getByProject(project)) {
    return { status: 409, body: { error: `a managed project with project "${project}" already exists` } };
  }
  if (trackerType === 'linear' && linearTeamKey && (await deps.managedProjectStore!.getByLinearTeamKey(linearTeamKey))) {
    return { status: 409, body: { error: `a managed project with linearTeamKey "${linearTeamKey}" already exists` } };
  }
  try {
    const created = await deps.managedProjectStore!.upsert(
      { project, repo, token, config, trackerType, linearTeamKey, linearTriggerLabelId, linearToken },
      deps.projectCredentialPublicKey!,
    );
    return { status: 201, body: created };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : 'failed to create managed project' } };
  }
}

async function handleUpdateProject(deps: ControlDeps, repo: string, req: IncomingMessage): Promise<HandlerResponse> {
  const existing = await deps.managedProjectStore!.get(repo);
  if (!existing) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = UpdateManagedProjectRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }
  // repo/project/trackerType are immutable identity -- pass the existing
  // values through; only token/config/linear-* come from the body (token
  // rotates, config set/clear/keep, linear-* only meaningful if already
  // linear-tracked -- the store rejects them otherwise).
  try {
    const updated = await deps.managedProjectStore!.upsert(
      {
        project: existing.project,
        repo: existing.repo,
        trackerType: existing.trackerType,
        token: parsed.data.token,
        config: parsed.data.config,
        linearTeamKey: parsed.data.linearTeamKey,
        linearTriggerLabelId: parsed.data.linearTriggerLabelId,
        linearToken: parsed.data.linearToken,
      },
      deps.projectCredentialPublicKey!,
    );
    return { status: 200, body: updated };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : 'failed to update managed project' } };
  }
}

async function handleDeleteProject(deps: ControlDeps, repo: string): Promise<HandlerResponse> {
  const existing = await deps.managedProjectStore!.get(repo);
  if (!existing) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  await deps.managedProjectStore!.remove(repo);
  return { status: 204 };
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
  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
    if (!isProjectCrudEnabled(deps)) {
      return { status: 503, body: { error: 'project CRUD is disabled (requires ENGINE_DB_*, PROJECT_CREDENTIAL_PUBLIC_KEY, and CONTROL_CRUD_TOKEN)' } };
    }
    if (!authorizeProjectCrud(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const projectMatch = matchPath('/api/projects/:repo', pathname);
    if (req.method === 'GET' && pathname === '/api/projects') {
      return handleListProjects(deps);
    }
    if (req.method === 'POST' && pathname === '/api/projects') {
      return handleCreateProject(deps, req);
    }
    if (projectMatch) {
      const { repo } = projectMatch.params;
      if (req.method === 'GET') {
        return handleGetProject(deps, repo);
      }
      if (req.method === 'PUT') {
        return handleUpdateProject(deps, repo, req);
      }
      if (req.method === 'DELETE') {
        return handleDeleteProject(deps, repo);
      }
    }
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
