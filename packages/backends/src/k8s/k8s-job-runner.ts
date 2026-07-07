import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Context } from '@temporalio/activity';
import { ApiException } from '@kubernetes/client-node';
import type { AgentRunResult, BackendRunRequest, VerifyService, VerifyServiceReadiness } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import type { CliSpec } from '../cli-spec';
import {
  ProcessCliAuthError,
  ProcessCliProcessError,
  ProcessCliTimeoutError,
} from '../process-cli-runner';
import type { BatchV1ApiLike } from './fake-batch-api';
import type { V1InitContainer, V1Job, V1ReadinessProbe } from './k8s-types';

export interface K8sJobRunnerOptions {
  namespace: string;
  workspacePvcName: string;
  workspaceMountPath: string;
  batchApi: BatchV1ApiLike;
  pollIntervalMs?: number;
  authSecretName?: string;
  additionalSecretNames?: string[];
  serviceAccountName?: string;
  podLabels?: Record<string, string>;
  runAsUser?: number;
  imagePullSecretName?: string;
  heartbeat?: () => void;
  now?: () => number;
}

const SHELL_REDIRECT =
  'exec "$0" "$@" < "$PROMPT_FILE" > "$OUT_FILE" 2> "$ERR_FILE"';

export function agentOpsArtifactPaths(req: BackendRunRequest): {
  dir: string;
  promptFile: string;
  outFile: string;
  errFile: string;
} {
  const id = `${req.stage}-${req.attempt}-${req.callIndex}`;
  const dir = path.join(req.workspaceRef, '.agentops');
  return {
    dir,
    promptFile: path.join(dir, `prompt-${id}.txt`),
    outFile: path.join(dir, `output-${id}.json`),
    errFile: path.join(dir, `error-${id}.log`),
  };
}

export function k8sJobName(req: BackendRunRequest): string {
  const raw = `agentops-${req.taskId}-${req.stage}-${req.attempt}-${req.callIndex}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

function toReadinessProbe(readiness: VerifyServiceReadiness): V1ReadinessProbe {
  return readiness.type === 'exec'
    ? { exec: { command: readiness.command } }
    : { tcpSocket: { port: readiness.port } };
}

function buildInitContainers(services: VerifyService[] | undefined): V1InitContainer[] | undefined {
  if (!services || services.length === 0) {
    return undefined;
  }
  return services.map((service) => ({
    name: service.name,
    image: service.image,
    restartPolicy: 'Always',
    env: service.env ? Object.entries(service.env).map(([name, value]) => ({ name, value })) : undefined,
    readinessProbe: toReadinessProbe(service.readiness),
  }));
}

export function buildAgentJob(
  req: BackendRunRequest,
  spec: CliSpec,
  opts: Pick<
    K8sJobRunnerOptions,
    | 'namespace'
    | 'workspacePvcName'
    | 'workspaceMountPath'
    | 'authSecretName'
    | 'additionalSecretNames'
    | 'serviceAccountName'
    | 'podLabels'
    | 'runAsUser'
    | 'imagePullSecretName'
  >,
  paths: ReturnType<typeof agentOpsArtifactPaths>,
): V1Job {
  const args = spec.buildArgs(req);
  const envFrom = [
    ...(opts.authSecretName ? [{ secretRef: { name: opts.authSecretName } }] : []),
    ...(opts.additionalSecretNames ?? []).map((name) => ({ secretRef: { name } })),
  ];
  const runAsUser = opts.runAsUser ?? 1000;
  const imagePullSecrets = opts.imagePullSecretName ? [{ name: opts.imagePullSecretName }] : undefined;
  const initContainers = buildInitContainers(req.services);

  return {
    metadata: {
      name: k8sJobName(req),
      namespace: opts.namespace,
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(req.limits.timeoutMs / 1000),
      template: {
        metadata: opts.podLabels ? { labels: opts.podLabels } : undefined,
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: opts.serviceAccountName,
          securityContext: { runAsNonRoot: true, runAsUser },
          imagePullSecrets,
          volumes: [
            {
              name: 'workspace-tasks',
              persistentVolumeClaim: { claimName: opts.workspacePvcName },
            },
          ],
          initContainers,
          containers: [
            {
              name: 'agent',
              image: req.image ?? spec.image,
              workingDir: req.workspaceRef,
              command: ['/bin/sh', '-c', SHELL_REDIRECT, spec.binary, ...args],
              env: [
                { name: 'PROMPT_FILE', value: paths.promptFile },
                { name: 'OUT_FILE', value: paths.outFile },
                { name: 'ERR_FILE', value: paths.errFile },
              ],
              envFrom: envFrom.length > 0 ? envFrom : undefined,
              securityContext: { runAsNonRoot: true, runAsUser, allowPrivilegeEscalation: false },
              volumeMounts: [
                {
                  name: 'workspace-tasks',
                  mountPath: opts.workspaceMountPath,
                },
              ],
            },
          ],
        },
      },
    },
  };
}

export class K8sJobRunner implements AgentBackend {
  private readonly pollIntervalMs: number;
  private readonly heartbeat: () => void;
  private readonly now: () => number;

  constructor(
    private readonly spec: CliSpec,
    private readonly opts: K8sJobRunnerOptions,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.heartbeat = opts.heartbeat ?? (() => Context.current().heartbeat());
    this.now = opts.now ?? Date.now;
  }

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.promptFile, req.prompt, 'utf8');

    const job = buildAgentJob(req, this.spec, this.opts, paths);
    const jobName = job.metadata!.name!;
    try {
      await this.opts.batchApi.createNamespacedJob(this.opts.namespace, job);
    } catch (err) {
      // The Job name is deterministic from (taskId, stage, attempt, callIndex), so a Temporal-level
      // retry of this same activity call reissues the exact same create. If an earlier retry's create
      // already succeeded but this runner never got to see it finish (e.g. the status poll below
      // failed), the Job is still there under that name -- reuse it instead of erroring forever.
      // Assumes buildAgentJob(req, ...) would still produce the same spec now (bounded retry backoff
      // is on the order of seconds, far under a deploy cycle) -- Jobs are immutable once created, so
      // there is nothing to reconcile if that assumption is ever wrong.
      if (!(err instanceof ApiException) || err.code !== 409) {
        throw err;
      }
    }

    const start = this.now();
    while (true) {
      try {
        this.heartbeat();
      } catch (err) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw err;
      }

      if (this.now() - start > req.limits.timeoutMs) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw new ProcessCliTimeoutError(`${this.spec.binary} timed out after ${req.limits.timeoutMs}ms`);
      }

      const { body: statusJob } = await this.opts.batchApi.readNamespacedJobStatus(
        jobName,
        this.opts.namespace,
      );
      const status = statusJob.status;

      if (status?.succeeded === 1 || status?.failed === 1) {
        const elapsedMs = this.now() - start;
        const stdout = await readFile(paths.outFile, 'utf8').catch(() => '');
        const stderr = await readFile(paths.errFile, 'utf8').catch(() => '');

        if (this.spec.isAuthError(stderr)) {
          throw new ProcessCliAuthError(stderr.trim());
        }
        if (stdout.trim().length === 0 && status.failed === 1) {
          throw new ProcessCliProcessError(
            `${this.spec.binary} job failed with no output: ${stderr.trim()}`,
          );
        }
        return this.spec.parseOutput(stdout, stderr, elapsedMs);
      }

      await sleep(this.pollIntervalMs);
    }
  }
}
