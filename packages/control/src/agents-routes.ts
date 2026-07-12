import {
  AgentScheduleSummarySchema,
  ListAgentSchedulesResponseSchema,
  TriggerAgentResponseSchema,
} from '@agentops/contracts';
import type { ControlDeps } from './create-control-server';
import type { HandlerResponse } from './handler-util';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function handleListAgents(deps: ControlDeps): Promise<HandlerResponse> {
  const agents: unknown[] = [];
  const lister = (deps.client.schedule as any).list?.bind(deps.client.schedule);
  if (lister) {
    for await (const s of lister()) {
      const id = (s as any).scheduleId as string | undefined;
      if (!id || !id.startsWith('agent:')) continue;
      const memo = (s as any).memo ?? {};
      const cron =
        (s as any)?.schedule?.spec?.cron?.cronString ?? (s as any)?.spec?.cron?.[0]?.cronString ?? '';
      agents.push(
        AgentScheduleSummarySchema.parse({
          scheduleId: id,
          project: memo.project ?? id.split(':')[1] ?? '',
          agentName: memo.agentName ?? id.split(':')[2] ?? '',
          workflow: memo.workflowType ?? '',
          cron,
          paused: Boolean((s as any)?.info?.paused),
        }),
      );
    }
  }
  return { status: 200, body: ListAgentSchedulesResponseSchema.parse({ agents }) };
}

export async function handleTriggerAgent(deps: ControlDeps, scheduleId: string): Promise<HandlerResponse> {
  const handle = (deps.client.schedule as any).getHandle(scheduleId);
  try {
    await handle.trigger();
  } catch {
    return { status: 404, body: { error: `no schedule "${scheduleId}"` } };
  }
  return { status: 202, body: TriggerAgentResponseSchema.parse({ scheduleId, triggered: true }) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */