import { NativeConnection, Worker } from '@temporalio/worker';
import { OpenTelemetryActivityInboundInterceptor } from '@temporalio/interceptors-opentelemetry/lib/worker';
import { defaultPayloadConverter } from '@temporalio/common';
import type { DevCycleActivities, PlatformActivities } from '@agentops/workflows';
import { projectContext } from '@agentops/activities';
import { PROJECT_HEADER_KEY } from '@agentops/contracts';
import type { TracingSetup } from './tracing';

/* eslint-disable @typescript-eslint/no-require-imports */
const OTEL_WORKFLOW_INTERCEPTOR_MODULE = require.resolve(
  '@temporalio/interceptors-opentelemetry/lib/workflow-interceptors',
);
const wfMain = require.resolve('@agentops/workflows');
const PROJECT_INTERCEPTOR_MODULE = require('path').join(require('path').dirname(wfMain), 'project-interceptor.ts');
/* eslint-enable @typescript-eslint/no-require-imports */

export interface CreateWorkerOptions {
  taskQueue: string;
  activities: DevCycleActivities & PlatformActivities;
  connection?: NativeConnection;
  workflowsPath?: string;
  namespace?: string;
  tracing?: TracingSetup;
}

export async function createWorker(options: CreateWorkerOptions): Promise<Worker> {
  const { tracing } = options;

  function projectInbound() {
    return {
      async execute(input: any, next: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
        const payload = input.headers?.[PROJECT_HEADER_KEY];
        const project = payload ? (defaultPayloadConverter.fromPayload(payload) as string) : undefined;
        return projectContext.run({ project }, () => next(input));
      },
    };
  }

  const baseActivityInterceptors = tracing
    ? [(_ctx: any) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(_ctx, { tracer: tracing.tracer }) })] // eslint-disable-line @typescript-eslint/no-explicit-any
    : [];
  const baseWorkflowModules = tracing ? [OTEL_WORKFLOW_INTERCEPTOR_MODULE] : [];

  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath ?? require.resolve('@agentops/workflows'),
    activities: options.activities as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
    sinks: tracing ? { exporter: tracing.workflowExporterSink } : undefined,
    interceptors: {
      activity: [
        (_ctx) => ({ inbound: projectInbound() }),
        ...baseActivityInterceptors,
      ],
      workflowModules: [PROJECT_INTERCEPTOR_MODULE, ...baseWorkflowModules],
    },
  });
}
