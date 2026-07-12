import { workflowInfo, type WorkflowInterceptorsFactory, type WorkflowOutboundCallsInterceptor } from '@temporalio/workflow';
import { defaultPayloadConverter } from '@temporalio/common';
import { PROJECT_HEADER_KEY, readProjectFromMemo } from '@agentops/contracts';

// Reads the workflow's own project identity (stamped in memo by the engine at
// start) and propagates it onto every outbound activity + child call. Loaded
// as a workflowModules entry on both the engine worker (createWorker) and the
// SDK's createEngineWorker, so both built-in and project workflows propagate
// identity uniformly. SP2 design §7.2.
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
