import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import {
  PlatformAgentResultSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  type ManagedProjectStore,
  type RunStats,
} from '@agentops/contracts';
import type { PostgresEngineSettingsStore, PostgresTierStore } from '@agentops/activities';
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
  // Managed-project registry (read-only). The engine's only source of truth
  // for projects is now the mounted `managed-projects` ConfigMap
  // (FileManagedProjectStore, built from MANAGED_PROJECTS_DIR in main.ts) --
  // the DB-backed CRUD store + X25519 credential crypto were retired once
  // worker/gateway/cli stopped needing them (see
  // docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md).
  // `GET /api/projects` and `GET /api/projects/:repo` read straight from it;
  // there is no write path anymore, so unlike the routes below this needs no
  // auth token -- it never exposes a token, only `credentialSet`/`tokenSecret`
  // (a Secret *name*, not a value).
  managedProjectStore?: ManagedProjectStore;
  // Tier table CRUD (SP3-B). Only needs ENGINE_DB_HOST; not credential-gated
  // like managed projects (tier edits are operational, not secret-bearing).
  tierStore?: PostgresTierStore;
  engineSettingsStore?: PostgresEngineSettingsStore;
  // Stats reader for budgets dashboard (simple slice). Same ENGINE_DB connection.
  statsStore?: { all(): Promise<RunStats[]> };
  // General control-mutation bearer token (sent as X-Control-Crud-Token),
  // fail-closed (401) when unset. Originally added to gate the managed-project
  // CRUD routes (now retired -- see managedProjectStore above), it has since
  // been reused to gate every other mutating route control exposes: POST
  // /api/platform/runs, POST /api/devcycle/runs, /api/platform/chats/*, PUT
  // /api/tiers, PUT /api/settings/self-heal, and POST /api/agents/:id/run.
  // Kept under its original name (and the CONTROL_CRUD_TOKEN env var / chart
  // knob) deliberately: it is still live-configured in the deployed cluster
  // (agentops-platform's engine values set projectCrudTokenSecretName) to
  // protect those routes, so removing it here would silently 401-lock all of
  // them. Issue #4 (Traefik basic-auth) is still required before the control
  // ingress goes public.
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

function constantTimeTokenEqual(
  configured: string | undefined,
  provided: string | string[] | undefined,
): boolean {
  // Defend against timing side-channels: measure the time taken to reject a wrong
  // token should not correlate with how many leading bytes were correct. Use
  // crypto.timingSafeEqual (constant-time) instead of === (short-circuits at first
  // differing byte). Also fail-closed when configured token is absent.
  if (!configured) {
    return false;
  }
  if (typeof provided !== 'string') {
    return false;
  }
  const configuredBuf = Buffer.from(configured, 'utf-8');
  const providedBuf = Buffer.from(provided, 'utf-8');
  if (configuredBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(configuredBuf, providedBuf);
}

// X-Control-Crud-Token (not Authorization): Traefik basic-auth on the control
// ingress consumes the Authorization header, so the bearer token uses a
// custom header to avoid collision. Works with or without basic-auth in front.
function authorizeControlToken(deps: ControlDeps, req: IncomingMessage): boolean {
  return constantTimeTokenEqual(deps.projectCrudAuthToken, req.headers['x-control-crud-token']);
}

// Read-only -- no auth token required (see the ControlDeps.managedProjectStore
// doc comment: nothing sensitive is exposed here anymore). No store configured
// means an empty list / a 404, same "graceful no-op" shape handleListRepos uses.
async function handleListProjects(deps: ControlDeps): Promise<HandlerResponse> {
  const projects = deps.managedProjectStore ? await deps.managedProjectStore.list() : [];
  return { status: 200, body: projects };
}

async function handleGetProject(deps: ControlDeps, repo: string): Promise<HandlerResponse> {
  const project = deps.managedProjectStore ? await deps.managedProjectStore.get(repo) : null;
  if (!project) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  return { status: 200, body: project };
}

async function dispatch(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse | undefined> {
  const url = new URL(req.url ?? '/', 'http://control.local');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/healthz') {
    return { status: 200 };
  }
  if (req.method === 'POST' && pathname === '/api/platform/runs') {
    if (!authorizeControlToken(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
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
    if (!authorizeControlToken(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
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
    if (!authorizeControlToken(deps, req)) {
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
      if (!authorizeControlToken(deps, req)) {
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
    // bearer token as the other mutating routes (GET stays open). Reuses
    // projectCrudAuthToken rather than introducing a second token: one
    // operator secret governs all fleet-mutating writes. Issue #4 (Traefik
    // basic-auth) is still required before the control ingress goes public.
    if (req.method === 'PUT') {
      if (!deps.tierStore || !authorizeControlToken(deps, req)) {
        return { status: 401, body: { error: 'unauthorized' } };
      }
      return handleReplaceTiers(deps, req);
    }
  }
  // Read-only (see ControlDeps.managedProjectStore) -- no auth, no 503 gating.
  // The write CRUD (POST/PUT/DELETE) was retired; the console is a viewer now.
  if (req.method === 'GET' && pathname === '/api/projects') {
    return handleListProjects(deps);
  }
  const projectMatch = matchPath('/api/projects/:repo', pathname);
  if (req.method === 'GET' && projectMatch) {
    return handleGetProject(deps, projectMatch.params.repo);
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
