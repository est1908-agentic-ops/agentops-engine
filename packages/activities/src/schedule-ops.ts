import type { ExistingSchedule, ReconcilePlan } from '@agentops/policies';
import { scheduleId } from '@agentops/policies';
import { ENGINE_QUEUE } from '@agentops/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The Temporal SDK ScheduleSpec expresses cron as `cronExpressions: string[]`
// with a top-level `timezone` (the client maps it to the proto's cronString
// internally). A `{ cron: { cronString } }` shape is NOT part of the public
// ScheduleSpec — the client silently ignores it, producing a schedule with no
// recurrence that never fires. Every create/update site MUST build its spec via
// `cronScheduleSpec` so the shape is correct-by-construction and typed.
export interface CronScheduleSpec {
  cronExpressions: string[];
  timezone: string;
}
export function cronScheduleSpec(cron: string, timezone = 'UTC'): CronScheduleSpec {
  return { cronExpressions: [cron], timezone };
}

export interface ScheduleStartWorkflowAction {
  type: 'startWorkflow';
  workflowType: string;
  args: unknown[];
  taskQueue: string;
  memo?: Record<string, unknown>;
  searchAttributes?: Record<string, unknown[]>;
}
export interface ScheduleCreateOpts {
  scheduleId: string;
  spec: CronScheduleSpec;
  action: ScheduleStartWorkflowAction;
  memo?: Record<string, unknown>;
  searchAttributes?: Record<string, unknown[]>;
}
export interface ScheduleUpdateOpts {
  action: ScheduleStartWorkflowAction;
  spec: CronScheduleSpec;
  memo?: Record<string, unknown>;
  searchAttributes?: Record<string, unknown[]>;
}

// Minimal surface we use from Temporal's ScheduleClient / ScheduleHandle.
// This lets tests inject a vi.fn() mock without depending on the full SDK shape,
// while the create/update opts are typed so a malformed spec can't compile.
// update() takes an updater function -- (previous) => newSchedule -- matching
// the real @temporalio/client ScheduleHandle.update signature. The updater returns
// a flat ScheduleUpdateOpts object (action, spec, memo, searchAttributes — no nested
// schedule wrapper). deps.scheduleClient is a raw cast of the real client (see
// worker/src/main.ts:453), so a mismatched shape here type-checks but throws at runtime.
// A prior version of this code returned { schedule: { spec, action }, memo, searchAttributes },
// which was silently ignored by the server, causing reconcile "successes" while schedules
// never actually got their fields corrected. This has been fixed to the correct flat shape.
export interface ScheduleHandleLike {
  update?: (updateFn: (previous: unknown) => ScheduleUpdateOpts) => Promise<void>;
  pause?: () => Promise<void>;
  unpause?: () => Promise<void>;
  delete?: () => Promise<void>;
  describe?: () => Promise<unknown>;
}

export interface ScheduleClientLike {
  create?: (opts: ScheduleCreateOpts) => Promise<ScheduleHandleLike>;
  getHandle: (id: string) => ScheduleHandleLike;
  list?: () => AsyncIterable<any>;
}

export interface ScheduleOpsDeps {
  scheduleClient?: ScheduleClientLike;
  // The queue the Schedules should target for the built-in workflows
  taskQueue?: string;
}

export async function listAgentSchedules(
  project: string,
  client?: ScheduleClientLike,
): Promise<ExistingSchedule[]> {
  if (!client) return [];
  const out: ExistingSchedule[] = [];
  // list() yields ScheduleSummary objects
  const lister = client.list;
  if (lister) {
    for await (const s of lister()) {
      const id = (s as any).scheduleId;
      if (!id || !id.startsWith(`agent:${project}:`)) continue;
      // scheduleSpec is recovered from memo (stored at creation): real SDK
      // summaries carry compiled calendars/intervals, not the original cron string.
      const memoSchedule = ((s as any)?.memo as Record<string, unknown> | undefined)?.schedule;
      const scheduleSpec = typeof memoSchedule === 'string' ? memoSchedule : 'continuous';
      let workflow = (s as any)?.action?.workflowType ?? 'whiteboxBugHunt';
      // The list() summary may omit taskQueue; when it does, describe() returns the
      // full action so reconcileAgents has a real queue to compare against --
      // otherwise task-queue mismatch detection is dead (issue #131).
      let taskQueue = (s as any)?.action?.taskQueue as string | undefined;
      if (taskQueue === undefined) {
        try {
          const desc = await client.getHandle(id).describe?.();
          if (desc) {
            taskQueue = (desc as any)?.action?.taskQueue ?? taskQueue;
            const descWorkflow = (desc as any)?.action?.workflowType;
            if (descWorkflow) workflow = descWorkflow;
          }
        } catch {
          // describe() failed; taskQueue stays undefined, workflow from summary
        }
      }
      // paused not directly on list item in all SDK versions; default false and rely on apply
      out.push({ id, scheduleSpec, workflow, paused: false, taskQueue });
    }
  }
  return out;
}

export async function applyScheduleChanges(
  project: string,
  repo: string,
  plan: ReconcilePlan,
  deps: ScheduleOpsDeps & { startWorkflow?: (workflowType: string, args: unknown[]) => unknown },
): Promise<void> {
  const client = deps.scheduleClient;
  if (!client) return; // no-op in environments without schedule client (tests often mock at higher level)
  const taskQueue = deps.taskQueue ?? ENGINE_QUEUE;

  for (const spec of plan.toCreate) {
    if (spec.schedule === 'continuous') continue; // SP1: Schedules only
    const id = scheduleId(project, spec.name);
    const args = [{ repo, project, ...spec.input }];
    const memo = { project, agentName: spec.name, workflowType: spec.workflow };
    const searchAttributes = {
      project: [project],
      agentName: [spec.name],
      workflowType: [spec.workflow],
    };
    if (client.create) {
      await client.create({
        scheduleId: id,
        spec: cronScheduleSpec(spec.schedule, spec.timezone),
        action: {
          type: 'startWorkflow',
          workflowType: spec.workflow,
          args,
          taskQueue,
          memo,
          searchAttributes,
        },
        memo: { ...memo, schedule: spec.schedule },
        searchAttributes,
      });
    }
  }

  for (const spec of plan.toUpdate) {
    if (spec.schedule === 'continuous') continue;
    const id = scheduleId(project, spec.name);
    const h = client.getHandle(id);
    const args = [{ repo, project, ...spec.input }];
    const memo = { project, agentName: spec.name, workflowType: spec.workflow };
    const searchAttributes = {
      project: [project],
      agentName: [spec.name],
      workflowType: [spec.workflow],
    };
    await h.update?.(() => ({
      action: {
        type: 'startWorkflow',
        workflowType: spec.workflow,
        args,
        taskQueue,
        memo,
        searchAttributes,
      },
      spec: cronScheduleSpec(spec.schedule, spec.timezone),
      memo: { ...memo, schedule: spec.schedule },
      searchAttributes,
    }));
  }

  for (const id of plan.toPause) {
    const h = client.getHandle(id);
    await h.pause?.();
  }
  for (const id of plan.toResume) {
    const h = client.getHandle(id);
    await h.unpause?.();
  }
  for (const id of plan.toDelete) {
    const h = client.getHandle(id);
    await h.delete?.();
  }
}
