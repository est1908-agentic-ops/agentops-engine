import {
  DevCycleRunDetailSchema,
  DevCycleTargetsResponseSchema,
  ListAgentSchedulesResponseSchema,
  ManagedProjectListResponseSchema,
  ManagedProjectSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartDevCycleResponseSchema,
  StartRunResponseSchema,
  z,
  type AgentScheduleSummary,
  type DevCycleRunDetail,
  type DevCycleTarget,
  type ManagedProject,
  type RunDetail,
  type RunListItem,
  type StartDevCycleRequest,
  type StartDevCycleResponse,
  type StartRunRequest,
  type StartRunResponse,
} from '@agentops/contracts';

// The managed-project CRUD routes are bearer-token-gated (CONTROL_CRUD_TOKEN).
// The browser holds the operator's copy of that token in localStorage and
// sends it as an Authorization header; it never leaves the operator's
// browser into the served app bundle. Issue #4 (Traefik basic-auth on the
// control ingress) is still required before the ingress goes public.
const CRUD_TOKEN_STORAGE_KEY = 'agentops.controlCrudToken';

export function getCrudToken(): string {
  return localStorage.getItem(CRUD_TOKEN_STORAGE_KEY) ?? '';
}

export function setCrudToken(token: string): void {
  if (token) {
    localStorage.setItem(CRUD_TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(CRUD_TOKEN_STORAGE_KEY);
  }
}

function crudHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getCrudToken();
  if (token) {
    // X-Control-Crud-Token (not Authorization) to avoid colliding with Traefik
    // basic-auth on the control ingress (design §7 / issue #4).
    headers['x-control-crud-token'] = token;
  }
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

async function parseJsonResponse<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
): Promise<z.output<S>> {
  const body: unknown = await res.json();
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new Error(message);
  }
  return schema.parse(body);
}

async function parseEmptyResponse(res: Response): Promise<void> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body: unknown = await res.json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        message = String((body as { error: unknown }).error);
      }
    } catch {
      // 204 No Content has no body -- keep the statusText message.
    }
    throw new Error(message);
  }
}

export async function startRun(input: StartRunRequest): Promise<StartRunResponse> {
  const res = await fetch('/api/platform/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJsonResponse(res, StartRunResponseSchema);
}

export async function listRuns(limit = 20): Promise<RunListItem[]> {
  const res = await fetch(`/api/platform/runs?limit=${limit}`);
  return parseJsonResponse(res, z.array(RunListItemSchema));
}

export async function getRun(workflowId: string): Promise<RunDetail> {
  const res = await fetch(`/api/platform/runs/${encodeURIComponent(workflowId)}`);
  return parseJsonResponse(res, RunDetailSchema);
}

export async function listRepos(): Promise<string[]> {
  const res = await fetch('/api/registry/repos');
  const parsed = await parseJsonResponse(res, RepoListResponseSchema);
  return parsed.repos;
}

// --- devCycle runs (prompt-devcycle design §6/§8) ---

export async function startDevCycleRun(input: StartDevCycleRequest): Promise<StartDevCycleResponse> {
  const res = await fetch('/api/devcycle/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJsonResponse(res, StartDevCycleResponseSchema);
}

export async function listDevCycleRuns(limit = 20): Promise<RunListItem[]> {
  const res = await fetch(`/api/devcycle/runs?limit=${limit}`);
  return parseJsonResponse(res, z.array(RunListItemSchema));
}

export async function getDevCycleRun(workflowId: string): Promise<DevCycleRunDetail> {
  const res = await fetch(`/api/devcycle/runs/${encodeURIComponent(workflowId)}`);
  return parseJsonResponse(res, DevCycleRunDetailSchema);
}

export async function listDevCycleTargets(): Promise<DevCycleTarget[]> {
  const res = await fetch('/api/devcycle/targets');
  const parsed = await parseJsonResponse(res, DevCycleTargetsResponseSchema);
  return parsed.targets;
}

/**
 * Builds a Temporal Web UI link for a different workflow (e.g. a
 * childWorkflow or an actionsTaken target) by swapping the workflowId
 * segment out of an existing run's temporalUrl, dropping any run-id/history
 * suffix -- Temporal resolves a workflow-only URL to its latest run.
 */
export function siblingTemporalUrl(temporalUrl: string, targetWorkflowId: string): string {
  const match = /^(.*\/namespaces\/[^/]+\/workflows\/)[^/]+(?:\/.*)?$/.exec(temporalUrl);
  if (!match) {
    return temporalUrl;
  }
  return `${match[1]}${encodeURIComponent(targetWorkflowId)}`;
}

// --- managed-project CRUD (design §7) ---

export interface CreateProjectInput {
  project: string;
  repo: string;
  token: string;
  configJson?: string;
  // `trackerType` + Linear fields mirror the contract's
  // CreateManagedProjectRequestSchema (control-projects-api.ts). trackerType
  // is GitHub by default; when 'linear', linearTeamKey/linearTriggerLabelId/
  // linearToken are required (server-side superRefine; client mirrors it).
  trackerType?: 'github' | 'linear';
  linearTeamKey?: string;
  linearTriggerLabelId?: string;
  linearToken?: string;
}

export interface UpdateProjectInput {
  token?: string;
  configJson?: string;
  // trackerType is immutable identity (like repo/project) -- it never
  // appears on update. The Linear fields rotate/keep like `token`.
  linearTeamKey?: string;
  linearTriggerLabelId?: string;
  linearToken?: string;
}

function parseConfigJson(configJson: string | undefined): unknown {
  if (configJson === undefined) {
    return undefined;
  }
  const trimmed = configJson.trim();
  if (trimmed === 'null') {
    return null;
  }
  return JSON.parse(trimmed);
}

export async function listProjects(): Promise<ManagedProject[]> {
  const res = await fetch('/api/projects', { headers: crudHeaders(false) });
  return parseJsonResponse(res, ManagedProjectListResponseSchema);
}

export async function getProject(repo: string): Promise<ManagedProject> {
  const res = await fetch(`/api/projects/${encodeURIComponent(repo)}`, {
    headers: crudHeaders(false),
  });
  return parseJsonResponse(res, ManagedProjectSchema);
}

export async function createProject(input: CreateProjectInput): Promise<ManagedProject> {
  const body: Record<string, unknown> = {
    project: input.project,
    repo: input.repo,
    token: input.token,
    config: parseConfigJson(input.configJson),
  };
  // Only send tracker/Linear keys when present -- the server defaults
  // trackerType to 'github' and runs the linear-required superRefine.
  if (input.trackerType) {
    body.trackerType = input.trackerType;
  }
  if (input.linearTeamKey) {
    body.linearTeamKey = input.linearTeamKey;
  }
  if (input.linearTriggerLabelId) {
    body.linearTriggerLabelId = input.linearTriggerLabelId;
  }
  if (input.linearToken) {
    body.linearToken = input.linearToken;
  }
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: crudHeaders(true),
    body: JSON.stringify(body),
  });
  return parseJsonResponse(res, ManagedProjectSchema);
}

export async function updateProject(
  repo: string,
  input: UpdateProjectInput,
): Promise<ManagedProject> {
  const payload: Record<string, unknown> = {};
  if (input.token !== undefined) payload.token = input.token;
  if (input.configJson !== undefined) payload.config = parseConfigJson(input.configJson);
  if (input.linearTeamKey !== undefined) payload.linearTeamKey = input.linearTeamKey;
  if (input.linearTriggerLabelId !== undefined)
    payload.linearTriggerLabelId = input.linearTriggerLabelId;
  if (input.linearToken !== undefined) payload.linearToken = input.linearToken;
  const res = await fetch(`/api/projects/${encodeURIComponent(repo)}`, {
    method: 'PUT',
    headers: crudHeaders(true),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res, ManagedProjectSchema);
}

export async function deleteProject(repo: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(repo)}`, {
    method: 'DELETE',
    headers: crudHeaders(false),
  });
  await parseEmptyResponse(res);
}

// --- agent schedules (SP3 run-from-UI) ---

export async function listAgents(): Promise<{ agents: AgentScheduleSummary[] }> {
  const res = await fetch('/api/agents');
  return parseJsonResponse(res, ListAgentSchedulesResponseSchema);
}

export async function runAgent(scheduleId: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(scheduleId)}/run`, {
    method: 'POST',
    headers: crudHeaders(false),
  });
  await parseEmptyResponse(res);
}
