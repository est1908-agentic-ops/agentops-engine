import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  // The per-repo base clone a task worktree links back to. When set, the PVC is
  // mounted into the agent Job pod at cacheMountPath so the worktree's `.git`
  // gitdir pointer (<cacheMountPath>/<repo>/.git/worktrees/<taskId>) resolves and
  // the agent can `git commit` to the task branch instead of falling back to a
  // fresh `git init` on `master`. Both fields must be set together; omitting them
  // (dev/in-process paths) mounts only the workspace volume, as before.
  cachePvcName?: string;
  cacheMountPath?: string;
  batchApi: BatchV1ApiLike;
  pollIntervalMs?: number;
  statusPollTimeoutMs?: number;
  authSecretName?: string;
  additionalSecretNames?: string[];
  serviceAccountName?: string;
  podLabels?: Record<string, string>;
  runAsUser?: number;
  imagePullSecretName?: string;
  heartbeat?: (details: unknown) => void;
  now?: () => number;
}

// readNamespacedJobStatus has no client-side timeout of its own (the
// generated K8s client doesn't expose an AbortSignal through this call
// shape) -- if the API server call itself hangs, the poll loop below freezes
// inside the `await`, never reaching its own req.limits.timeoutMs check or
// the next heartbeat, so Temporal's heartbeatTimeout becomes the only
// backstop (and fires identically on every retry, since the underlying hang
// recurs). Racing the call against this timeout turns that into a normal,
// retryable "no status this tick" instead -- see issue-broccoli-94.
class StatusPollTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StatusPollTimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

// A plain `exec ... > OUT 2> ERR` sent the CLI's entire output only to
// files on the workspace PVC -- nothing reached the container's own
// stdout/stderr, so Alloy (which scrapes container logs, not PVC files)
// captured nothing for the `agent` container. This mirrors the same
// output to both: FIFOs decouple the CLI's write from `tee`'s dual
// write, and the CLI's exit code is captured explicitly in $CODE rather
// than relying on `set -o pipefail`, which dash (a common /bin/sh) does
// not support.
const SHELL_REDIRECT = [
  'rm -f /tmp/agentops-out /tmp/agentops-err',
  'mkfifo /tmp/agentops-out /tmp/agentops-err',
  'tee "$OUT_FILE" < /tmp/agentops-out &',
  'tee "$ERR_FILE" < /tmp/agentops-err >&2 &',
  '"$0" "$@" < "$PROMPT_FILE" > /tmp/agentops-out 2> /tmp/agentops-err',
  'CODE=$?',
  'wait',
  'exit "$CODE"',
].join('\n');

// A call's on-disk artifacts and its K8s Job are keyed by
// (taskId, stage, attempt, callIndex) AND the model. A RateLimitFallbackBackend
// retry reruns the exact same call with a different model, so without the model
// in the key the fallback would 409-reuse the primary model's already-finished
// Job and re-read its (rate-limited) output instead of actually running the
// fallback. Folded in as a short stable hash so K8s names stay under the 63-char
// limit and filenames stay safe; it's deterministic, so Temporal retries of the
// same call still reuse the same Job/artifacts.
function modelKey(model: string): string {
  return createHash('sha256').update(model).digest('hex').slice(0, 8);
}

export function agentOpsArtifactPaths(req: BackendRunRequest): {
  dir: string;
  promptFile: string;
  outFile: string;
  errFile: string;
} {
  const id = `${req.stage}-${req.attempt}-${req.callIndex}-${modelKey(req.model)}`;
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
  const suffix = `-${modelKey(req.model)}`;
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63 - suffix.length)
    .replace(/-+$/g, '');
  return `${base}${suffix}`;
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
    | 'cachePvcName'
    | 'cacheMountPath'
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
  const image = req.image ?? spec.image;
  // A "CHANGEME" placeholder means whoever wired this up (an operator's
  // AGENT_RUNNER_IMAGE, or a project's own agentops.json) never got replaced
  // with a real image -- letting that reach the cluster means an
  // ImagePullBackOff that eats the activity's timeout before failing, instead
  // of a clear error at the one point that actually knows the image is fake.
  if (image.includes('CHANGEME')) {
    throw new Error(
      `refusing to build a Job with a placeholder image ("${image}") -- set a real image via the project's ` +
        'agentops.json "image" field or the worker\'s AGENT_RUNNER_IMAGE env var.',
    );
  }
  const envFrom = [
    ...(opts.authSecretName ? [{ secretRef: { name: opts.authSecretName } }] : []),
    ...(opts.additionalSecretNames ?? []).map((name) => ({ secretRef: { name } })),
  ];
  const runAsUser = opts.runAsUser ?? 1000;
  const imagePullSecrets = opts.imagePullSecretName ? [{ name: opts.imagePullSecretName }] : undefined;
  const initContainers = buildInitContainers(req.services);

  // Mount the base-clone cache too, so the worktree's `.git` gitdir resolves and
  // the agent can commit to the task branch (see K8sJobRunnerOptions.cachePvcName).
  // Both fields go together; if either is unset, fall back to the task volume only.
  const mountCache = Boolean(opts.cachePvcName && opts.cacheMountPath);
  const cacheVolume = mountCache
    ? [{ name: 'workspace-cache', persistentVolumeClaim: { claimName: opts.cachePvcName! } }]
    : [];
  const cacheMount = mountCache ? [{ name: 'workspace-cache', mountPath: opts.cacheMountPath! }] : [];

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
            ...cacheVolume,
          ],
          initContainers,
          containers: [
            {
              name: 'agent',
              image,
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
                ...cacheMount,
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
  private readonly statusPollTimeoutMs: number;
  private readonly heartbeat: (details: unknown) => void;
  private readonly now: () => number;

  constructor(
    private readonly spec: CliSpec,
    private readonly opts: K8sJobRunnerOptions,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.statusPollTimeoutMs = opts.statusPollTimeoutMs ?? 10_000;
    this.heartbeat = opts.heartbeat ?? ((details) => Context.current().heartbeat(details));
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
    let lastStatus: V1Job['status'];
    let lastProgressAt = start;
    let lastOutputBytes = 0;
    let lastErrorBytes = 0;
    const idleTimeoutMs = req.limits.idleTimeoutMs ?? req.limits.timeoutMs;
    while (true) {
      const outputBytes = await fileSize(paths.outFile);
      const errorBytes = await fileSize(paths.errFile);
      if (outputBytes > lastOutputBytes || errorBytes > lastErrorBytes) {
        lastProgressAt = this.now();
      }
      lastOutputBytes = outputBytes;
      lastErrorBytes = errorBytes;

      try {
        this.heartbeat({
          phase: lastStatus ? 'polling' : 'job-created',
          jobName,
          taskId: req.taskId,
          stage: req.stage,
          elapsedMs: this.now() - start,
          idleMs: this.now() - lastProgressAt,
          timeoutMs: req.limits.timeoutMs,
          outputBytes,
          errorBytes,
          jobStatus: lastStatus,
        });
      } catch (err) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw err;
      }

      if (this.now() - lastProgressAt > idleTimeoutMs) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw new ProcessCliTimeoutError(
          `${this.spec.binary} produced no output for ${idleTimeoutMs}ms (idle since elapsed ${lastProgressAt - start}ms)`,
        );
      }

      if (this.now() - start > req.limits.timeoutMs) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw new ProcessCliTimeoutError(
          `${this.spec.binary} exceeded overall ${req.limits.timeoutMs}ms budget despite ongoing output`,
        );
      }

      let statusJob: V1Job;
      try {
        ({ body: statusJob } = await withTimeout(
          this.opts.batchApi.readNamespacedJobStatus(jobName, this.opts.namespace),
          this.statusPollTimeoutMs,
          `readNamespacedJobStatus timed out after ${this.statusPollTimeoutMs}ms for job ${jobName}`,
        ));
      } catch (err) {
        if (!(err instanceof StatusPollTimeoutError)) {
          throw err;
        }
        console.warn(
          JSON.stringify({
            event: 'k8s-status-poll-timeout',
            jobName,
            taskId: req.taskId,
            stage: req.stage,
            statusPollTimeoutMs: this.statusPollTimeoutMs,
          }),
        );
        await sleep(this.pollIntervalMs);
        continue;
      }
      lastStatus = statusJob.status;

      if (lastStatus?.succeeded === 1 || lastStatus?.failed === 1) {
        const elapsedMs = this.now() - start;
        const stdout = await readFile(paths.outFile, 'utf8').catch(() => '');
        const stderr = await readFile(paths.errFile, 'utf8').catch(() => '');

        if (this.spec.isAuthError(stderr)) {
          throw new ProcessCliAuthError(stderr.trim());
        }
        if (stdout.trim().length === 0 && lastStatus.failed === 1) {
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
