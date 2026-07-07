import {
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunResponseSchema,
  z,
  type RunDetail,
  type RunListItem,
  type StartRunRequest,
  type StartRunResponse,
} from '@agentops/contracts';

async function parseJsonResponse<S extends z.ZodTypeAny>(res: Response, schema: S): Promise<z.output<S>> {
  const body: unknown = await res.json();
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new Error(message);
  }
  return schema.parse(body);
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
