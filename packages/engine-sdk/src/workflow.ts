import { proxyActivities, executeChild, workflowInfo, type WorkflowInterceptorsFactory, type WorkflowOutboundCallsInterceptor } from '@temporalio/workflow';
import { defaultPayloadConverter } from '@temporalio/common';
import type { EngineActivities } from '@agentops/contracts';
import { ENGINE_QUEUE, PROJECT_HEADER_KEY, readProjectFromMemo } from '@agentops/contracts';
export { ENGINE_QUEUE };
export type { EngineActivities } from '@agentops/contracts';
export { parseFindings } from '@agentops/policies';
export { parseVerdict } from '@agentops/policies';
import type { DevCycleState, TaskInput } from '@agentops/contracts';

// Proxy the engine's activities onto ENGINE_QUEUE so privileged, credential-
// holding work runs on the engine's workers, not the project worker.
export function engineActivities(opts: { startToCloseTimeout?: string } = {}) {
  return proxyActivities<EngineActivities>({ taskQueue: ENGINE_QUEUE, startToCloseTimeout: opts.startToCloseTimeout ?? ('10m' as any) }); // eslint-disable-line @typescript-eslint/no-explicit-any
}
// Longer default for agent runs.
export function engineAgent(opts: { startToCloseTimeout?: string } = {}) {
  return proxyActivities<EngineActivities>({ taskQueue: ENGINE_QUEUE, startToCloseTimeout: opts.startToCloseTimeout ?? ('1h' as any) }); // eslint-disable-line @typescript-eslint/no-explicit-any
}
// Run the built-in devCycle pipeline on the engine, started by name.
export function childDevCycle(input: TaskInput): Promise<DevCycleState> {
  return executeChild('devCycle', { taskQueue: ENGINE_QUEUE, args: [input] });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class ProjectOutbound implements WorkflowOutboundCallsInterceptor {
  private project(): string | undefined {
    return readProjectFromMemo(workflowInfo().memo as Record<string, unknown> | undefined);
  }
  async scheduleActivity(input: any, next: any) {
    const p = this.project();
    if (p) input.headers = { ...input.headers, [PROJECT_HEADER_KEY]: defaultPayloadConverter.toPayload(p) };
    return next(input);
  }
  async startChildWorkflowExecution(input: any, next: any) {
    const p = this.project();
    if (p) {
      input.headers = { ...input.headers, [PROJECT_HEADER_KEY]: defaultPayloadConverter.toPayload(p) };
      input.options = {
        ...input.options,
        memo: { ...(input.options?.memo ?? {}), project: p },
        searchAttributes: { ...(input.options?.searchAttributes ?? {}), project: [p] },
      };
    }
    return next(input);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const interceptors: WorkflowInterceptorsFactory = () => ({ outbound: [new ProjectOutbound()] });
