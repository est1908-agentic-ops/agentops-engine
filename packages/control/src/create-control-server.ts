import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import {
  PlatformAgentResultSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  CreateManagedProjectRequestSchema,
  UpdateManagedProjectRequestSchema,
  type RunStats,
} from '@agentops/contracts';
import type { PostgresEngineSettingsStore, PostgresManagedProjectStore, PostgresTierStore } from '@agentops/activities';
import { platform } from '@agentops/workflows';
import { listRunsByType, memoPrompt, readJsonBody, type HandlerResponse } from './handler-util';
import {
  handleGetDevCycleRun,
  handleListDevCycleRuns,
  handleListDevCycleTargets,
  handleStartDevCycleRun,
} from './devcycle-routes';
import { handleListAgents, handleTriggerAgent } from './agents-routes';
import {
  handleCloseChat,
  handleDecision,
  handleGetChat,
  handleListChats,
  handleSendTurn,
  handleStartChat,
} from './chat-routes';
import { handleListTiers, handleReplaceTiers } from './tiers-routes';
import { handleGetSelfHealSettings, handleUpdateSelfHealSettings } from './settings-routes';
import { handleGetBudgets } from './budgets-routes';
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
  // Tier table CRUD (SP3-B). Only needs ENGINE_DB_HOST; not credential-gated
  // like managed projects (tier edits are operational, not secret-bearing).
  tierStore?: PostgresTierStore;
  engineSettingsStore?: PostgresEngineSettingsStore;
  // Stats reader for budgets dashboard (simple slice). Same ENGINE_DB connection.
  statsStore?: { all(): Promise<RunStats[]> };
  projectCredentialPublicKey?: string;
  projectCrudAuthToken?: string;
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
  return listRunsByType(deps, url, 'platform');
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

function authorizeControlToken(deps: ControlDeps, req: IncomingMessage): boolean {
  return Boolean(deps.projectCrudAuthToken) && req.headers['x-control-crud-token'] === deps.projectCrudAuthToken;
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
  if (req.method === 'POST' && pathname === '/api/devcycle/runs') {
    return handleStartDevCycleRun(deps, req);
  }
  if (req.method === 'GET' && pathname === '/api/devcycle/runs') {
    return handleListDevCycleRuns(deps, url);
  }
  const devCycleRunMatch = matchPath('/api/devcycle/runs/:workflowId', pathname);
  if (req.method === 'GET' && devCycleRunMatch) {
    return handleGetDevCycleRun(deps, devCycleRunMatch.params.workflowId);
  }
  if (req.method === 'GET' && pathname === '/api/devcycle/targets') {
    return handleListDevCycleTargets(deps);
  }
  if (req.method === 'GET' && pathname === '/api/registry/repos') {
    return handleListRepos(deps);
  }
  if (req.method === 'GET' && pathname === '/api/budgets') {
    return handleGetBudgets(deps);
  }
  if (req.method === 'GET' && pathname === '/api/agents') {
    return handleListAgents(deps);
  }
  const agentRun = matchPath('/api/agents/:scheduleId/run', pathname);
  if (req.method === 'POST' && agentRun) {
    if (!authorizeProjectCrud(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    return handleTriggerAgent(deps, agentRun.params.scheduleId);
  }
  if (pathname === '/api/platform/chats' || pathname.startsWith('/api/platform/chats/')) {
    if (!authorizeControlToken(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (req.method === 'POST' && pathname === '/api/platform/chats') {
      return handleStartChat(deps, req);
    }
    if (req.method === 'GET' && pathname === '/api/platform/chats') {
      return handleListChats(deps, url);
    }
    const turnMatch = matchPath('/api/platform/chats/:chatId/turns', pathname);
    if (req.method === 'POST' && turnMatch) {
      return handleSendTurn(deps, turnMatch.params.chatId, req);
    }
    const decisionMatch = matchPath('/api/platform/chats/:chatId/decisions', pathname);
    if (req.method === 'POST' && decisionMatch) {
      return handleDecision(deps, decisionMatch.params.chatId, req);
    }
    const closeMatch = matchPath('/api/platform/chats/:chatId/close', pathname);
    if (req.method === 'POST' && closeMatch) {
      return handleCloseChat(deps, closeMatch.params.chatId);
    }
    const chatMatch = matchPath('/api/platform/chats/:chatId', pathname);
    if (req.method === 'GET' && chatMatch) {
      return handleGetChat(deps, chatMatch.params.chatId);
    }
  }
  if (pathname === '/api/settings/self-heal') {
    if (req.method === 'GET') {
      return handleGetSelfHealSettings(deps);
    }
    if (req.method === 'PUT') {
      if (!authorizeProjectCrud(deps, req)) {
        return { status: 401, body: { error: 'unauthorized' } };
      }
      return handleUpdateSelfHealSettings(deps, req);
    }
  }
  if (pathname === '/api/tiers') {
    if (req.method === 'GET') {
      return handleListTiers(deps);
    }
    // PUT rewrites the whole fleet's model routing -- gate it behind the same
    // bearer token as /api/projects (GET stays open). Reuses projectCrudAuthToken
    // rather than introducing a second token: one operator secret governs all
    // fleet-mutating writes. Issue #4 (Traefik basic-auth) is still required
    // before the control ingress goes public.
    if (req.method === 'PUT') {
      if (!deps.tierStore || !authorizeProjectCrud(deps, req)) {
        return { status: 401, body: { error: 'unauthorized' } };
      }
      return handleReplaceTiers(deps, req);
    }
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
