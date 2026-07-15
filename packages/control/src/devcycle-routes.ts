import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  DevCycleRunDetailSchema,
  DevCycleStateSchema,
  DevCycleTargetsResponseSchema,
  StartDevCycleRequestSchema,
  StartDevCycleResponseSchema,
} from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import type { ControlDeps } from './create-control-server';
import { listRunsByType, memoPrompt, readJsonBody, type HandlerResponse } from './handler-util';

// Managed store only -- the static PROJECT_REGISTRY_JSON registry this
// fell back to no longer exists (see the Linear trigger design doc's DB-only
// addendum). The store normalizes the repo internally (normalizeRepo), so
// URL- and short-form identifiers are interchangeable. No store configured
// (or repo not registered) means we cannot start/resolve -> callers surface
// a 422, exactly like the worker's registry lookup.
async function resolveProjectSlug(deps: ControlDeps, repo: string): Promise<string | undefined> {
  if (!deps.managedProjectStore) {
    return undefined;
  }
  const managed = await deps.managedProjectStore.get(repo);
  return managed?.project;
}

export async function handleStartDevCycleRun(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = StartDevCycleRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }

  const { repo, prompt } = parsed.data;
  const project = await resolveProjectSlug(deps, repo);
  if (!project) {
    return { status: 422, body: { error: `repo "${repo}" is not a registered project` } };
  }

  const taskId = parsed.data.taskId ?? randomUUID();
  const workflowId = `prompt-${project}-${taskId}`;
  try {
    const handle = await deps.client.workflow.start(devCycle, {
      taskQueue: deps.taskQueue,
      workflowId,
      // No config on purpose: the workflow resolves it on the worker via
      // resolveRepoConfig -- control never holds repo credentials
      // so the workflow resolves the registered project configuration.
      args: [{ taskId, project, repo, goal: prompt }],
      memo: { prompt },
    });
    return {
      status: 202,
      body: StartDevCycleResponseSchema.parse({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId, taskId }),
    };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { status: 409, body: { error: `a run with workflowId "${workflowId}" already exists` } };
    }
    throw err;
  }
}

export async function handleListDevCycleRuns(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
  return listRunsByType(deps, url, 'devCycle');
}

export async function handleGetDevCycleRun(deps: ControlDeps, workflowId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle(workflowId);

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

  if (status === 'RUNNING') {
    try {
      const state = DevCycleStateSchema.parse(await handle.query('state'));
      return { status: 200, body: DevCycleRunDetailSchema.parse({ ...base, state }) };
    } catch {
      // The run may have closed between describe() and query(), or returned
      // an unexpected shape -- serve the bare status; the UI's next poll
      // sees the closed run.
      return { status: 200, body: DevCycleRunDetailSchema.parse(base) };
    }
  }

  if (status === 'COMPLETED') {
    try {
      const result = DevCycleStateSchema.safeParse(await handle.result());
      if (!result.success) {
        return {
          status: 200,
          body: DevCycleRunDetailSchema.parse({ ...base, error: 'run completed but its result did not match the expected shape' }),
        };
      }
      return { status: 200, body: DevCycleRunDetailSchema.parse({ ...base, state: result.data }) };
    } catch (err) {
      return {
        status: 200,
        body: DevCycleRunDetailSchema.parse({ ...base, error: err instanceof Error ? err.message : 'failed to fetch workflow result' }),
      };
    }
  }

  return { status: 200, body: DevCycleRunDetailSchema.parse({ ...base, error: `workflow ended with status ${status}` }) };
}

export async function handleListDevCycleTargets(deps: ControlDeps): Promise<HandlerResponse> {
  // Identity only (repo + project slug) -- never credentials or config, so
  // this is safe to serve ungated, exactly like /api/registry/repos. The
  // CRUD token keeps guarding everything that touches credentials. Source is
  // the managed-project store only (DB-only design).
  const targets = deps.managedProjectStore
    ? (await deps.managedProjectStore.list()).map((row) => ({ repo: row.repo, project: row.project }))
    : [];
  targets.sort((a, b) => a.project.localeCompare(b.project));
  return { status: 200, body: DevCycleTargetsResponseSchema.parse({ targets }) };
}
