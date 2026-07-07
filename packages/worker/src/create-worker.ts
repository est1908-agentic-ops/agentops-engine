import { NativeConnection, Worker } from '@temporalio/worker';
import { OpenTelemetryActivityInboundInterceptor } from '@temporalio/interceptors-opentelemetry/lib/worker';
import type { DevCycleActivities, PlatformActivities } from '@agentops/workflows';
import type { TracingSetup } from './tracing';

const OTEL_WORKFLOW_INTERCEPTOR_MODULE = require.resolve(
  '@temporalio/interceptors-opentelemetry/lib/workflow-interceptors',
);

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
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath ?? require.resolve('@agentops/workflows'),
    activities: options.activities as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
    sinks: tracing ? { exporter: tracing.workflowExporterSink } : undefined,
    interceptors: tracing
      ? {
          activity: [(ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx, { tracer: tracing.tracer }) })],
          workflowModules: [OTEL_WORKFLOW_INTERCEPTOR_MODULE],
        }
      : undefined,
  });
}
