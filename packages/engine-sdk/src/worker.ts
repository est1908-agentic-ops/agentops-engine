import { Worker, type NativeConnection } from '@temporalio/worker';
// defaultPayloadConverter and PROJECT_HEADER_KEY reserved for inbound header decode if project-side auditing added
/* eslint-disable @typescript-eslint/no-unused-vars */
import { defaultPayloadConverter } from '@temporalio/common';
import { PROJECT_HEADER_KEY } from '@agentops/contracts';
/* eslint-enable @typescript-eslint/no-unused-vars */

export interface CreateEngineWorkerOptions {
  taskQueue: string;
  workflowsPath: string;
  activities: Record<string, (...args: never[]) => Promise<unknown>>;
  connection?: NativeConnection;
  namespace?: string;
}

// Creates a project worker that: (1) runs the project's own workflows +
// activities; (2) propagates project identity outbound via the bundled
// interceptor module; (3) exposes the inbound header so the engine can
// validate repo-ownership. The project identity itself is stamped at start by
// the engine reconciler (memo), never chosen here. SP2 design §7.2.
export function createEngineWorker(options: CreateEngineWorkerOptions) {
  // For the SDK's published package the interceptor is inlined in the workflow bundle entry;
  // worker side loads the interceptor module for outbound.
  // To keep self-contained we inline a passthrough here too and rely on the workflow module.
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    interceptors: {
      activity: [
        () => ({
          inbound: {
            async execute(input: any, next: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
              // Project workers do not consume the inbound project header
              // themselves (they hold no credentials); the engine's own worker
              // enforces it. This inbound is a no-op passthrough kept for
              // symmetry / future project-side auditing.
              return next(input);
            },
          },
        }),
      ],
      workflowModules: [(() => { try { return require.resolve('./workflow'); } catch { return './workflow'; } })()], // the workflow entry also exports interceptors but Temporal loads modules for outbound
    },
  });
}
