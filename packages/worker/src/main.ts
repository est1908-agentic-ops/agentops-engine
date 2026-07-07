import { NativeConnection } from '@temporalio/worker';
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node';
import { Pool } from 'pg';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
  loadProjectRegistry,
  MemoryWorkspaceManager,
  PostgresStatsStore,
  SpawnGitCommandRunner,
  WorkspaceManager,
  type StatsStore,
  type Workspaces,
} from '@agentops/activities';

loadEnv();
import {
  batchApiFromClient,
  createClaudeCliSpec,
  createPiCliSpec,
  K8sJobRunner,
  LiteLlmBackend,
  ProcessCliRunner,
  RateWindowedBackend,
  RateWindowLimiter,
  StubBackend,
  type AgentBackend,
  type BatchV1ApiLike,
  type K8sJobRunnerOptions,
} from '@agentops/backends';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import {
  createGithubPorts,
  createProjectScopedPorts,
  githubCloneUrl,
  MemoryScmPort,
  MemoryTrackerPort,
  type ScmPort,
  type TrackerPort,
} from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import type { DevCycleActivities, PlatformActivities } from '@agentops/workflows';
import { createWorker } from './create-worker';
import { setupTracing } from './tracing';

export interface ActivityWiring {
  scm: ScmPort;
  tracker: TrackerPort;
  workspaces: Workspaces;
}

export function buildActivityDependencies(registry: ResolvedProjectEntry[]): ActivityWiring {
  if (registry.length === 0) {
    return { scm: new MemoryScmPort(), tracker: new MemoryTrackerPort(), workspaces: new MemoryWorkspaceManager() };
  }
  const entries = registry.map((entry) => {
    const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
    const { scm, tracker } = createGithubPorts(entry.token, git);
    return { repo: entry.repo, scm, tracker, git };
  });
  const { scm, tracker, resolveGit } = createProjectScopedPorts(entries);
  return { scm, tracker, workspaces: new WorkspaceManager({ resolveGit, cloneUrl: githubCloneUrl }) };
}

export function buildJobRunnerOptions(
  batchApi: BatchV1ApiLike,
  opts: { authSecretName?: string; serviceAccountName?: string; additionalSecretNames?: string[]; podLabels?: Record<string, string> } = {},
): K8sJobRunnerOptions {
  return {
    namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
    workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
    workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
    authSecretName: opts.authSecretName,
    additionalSecretNames: opts.additionalSecretNames,
    serviceAccountName: opts.serviceAccountName,
    podLabels: opts.podLabels,
    runAsUser: process.env.AGENT_RUNNER_UID ? Number(process.env.AGENT_RUNNER_UID) : undefined,
    imagePullSecretName: process.env.IMAGE_PULL_SECRET_NAME,
    batchApi,
  };
}

// Subscription rate windows (ARCHITECTURE.md §5.5/§9: "prompts per 5h/week")
// are real per-provider constraints, but the actual quota depends on which
// plan tier is in use -- nothing here hardcodes a number. Unset (the
// default) means unlimited, same as today; set both env vars for a backend
// to turn the limit on. In-memory, per-worker-process: correct for today's
// single-replica deployment, not for multiple replicas sharing one quota
// (see RateWindowLimiter).
function wrapWithRateWindow(backend: AgentBackend, envPrefix: string, name: string): AgentBackend {
  const maxCalls = Number(process.env[`${envPrefix}_RATE_WINDOW_MAX_CALLS`]);
  const windowMs = Number(process.env[`${envPrefix}_RATE_WINDOW_MS`]);
  if (!Number.isFinite(maxCalls) || maxCalls <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return backend;
  }
  return new RateWindowedBackend(backend, new RateWindowLimiter({ maxCalls, windowMs }), name);
}

export function buildBackends(inCluster: boolean): Record<string, AgentBackend> {
  const agentImage =
    process.env.AGENT_RUNNER_IMAGE ?? 'ghcr.io/CHANGEME/agentops-engine/agent-runner:CHANGEME';
  const claudeSpec = createClaudeCliSpec({ image: agentImage });
  const piSpec = createPiCliSpec({ image: agentImage });
  // Not a CLI spawn, so it doesn't switch between ProcessCliRunner and
  // K8sJobRunner like claude/pi do -- it's a plain HTTP call to LiteLLM's
  // in-cluster Service, made directly from the worker/activity either way.
  const litellm = new LiteLlmBackend({
    baseUrl: process.env.LITELLM_BASE_URL ?? 'http://litellm.platform.svc.cluster.local:4000',
    apiKey: process.env.LITELLM_API_KEY ?? '',
  });

  if (!inCluster) {
    return {
      stub: new StubBackend(),
      claude: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), 'CLAUDE', 'claude'),
      pi: wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'pi'),
      platform: wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'platform'),
      litellm,
    };
  }

  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batchApi = batchApiFromClient(kc.makeApiClient(BatchV1Api));

  return {
    stub: new StubBackend(),
    // Each backend gets its own auth secret — claude's z.ai/Anthropic env vars
    // and pi's (provider-dependent, see images/agent-runner/Dockerfile) are not
    // guaranteed to be the same shape, so they were never safe to share.
    claude: wrapWithRateWindow(
      new K8sJobRunner(claudeSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME })),
      'CLAUDE',
      'claude',
    ),
    pi: wrapWithRateWindow(
      new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
      'PI',
      'pi',
    ),
    platform: wrapWithRateWindow(
      new K8sJobRunner(
        piSpec,
        buildJobRunnerOptions(batchApi, {
          authSecretName: process.env.PI_AUTH_SECRET_NAME,
          serviceAccountName: process.env.PLATFORM_AGENT_SERVICE_ACCOUNT,
          additionalSecretNames: process.env.PLATFORM_AGENT_SECRET_NAME ? [process.env.PLATFORM_AGENT_SECRET_NAME] : undefined,
          podLabels: { 'agentops/role': 'platform-agent' },
        }),
      ),
      'PI',
      'platform',
    ),
    litellm,
  };
}

export async function buildStatsStore(): Promise<StatsStore> {
  const host = process.env.AGENT_STATS_DB_HOST;
  if (!host) {
    return new InMemoryStatsStore();
  }
  const pool = new Pool({
    host,
    port: process.env.AGENT_STATS_DB_PORT ? Number(process.env.AGENT_STATS_DB_PORT) : 5432,
    database: process.env.AGENT_STATS_DB_NAME ?? 'agent_run_stats',
    user: process.env.AGENT_STATS_DB_USER ?? 'temporal',
    password: process.env.AGENT_STATS_DB_PASSWORD,
  });
  const store = new PostgresStatsStore(pool);
  await store.ensureSchema();
  return store;
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const registry = loadProjectRegistry();
  const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const { scm, tracker, workspaces } = buildActivityDependencies(registry);
  console.log(
    registry.length > 0
      ? `agentops worker: LIVE mode — ${registry.length} project(s) registered: ${registry
          .map((entry) => `${entry.product} (${entry.repo})`)
          .join(', ')} — real GitHub + real agent CLIs, will spend tokens and open real PRs`
      : 'agentops worker: DEMO mode (no PROJECT_REGISTRY_JSON) — in-memory ports + stub backend only',
  );
  console.log(
    inCluster
      ? 'agentops worker: IN-CLUSTER mode (KUBERNETES_SERVICE_HOST set) — claude runs as K8s Jobs'
      : 'agentops worker: LOCAL mode — claude/pi spawn as local processes',
  );

  const stats = await buildStatsStore();
  console.log(
    stats instanceof PostgresStatsStore
      ? 'agentops worker: agent_run_stats persisted to Postgres (AGENT_STATS_DB_HOST set)'
      : 'agentops worker: agent_run_stats in-memory only (AGENT_STATS_DB_HOST not set)',
  );

  const activities: DevCycleActivities & PlatformActivities = createActivities({
    backends: buildBackends(inCluster),
    tracker,
    scm,
    stats,
    stageResults: new InMemoryStageResultStore(),
    workspaces,
    prompts: new PromptPack(),
    registry,
  });

  const tracing = setupTracing();
  console.log(
    tracing
      ? 'agentops worker: tracing ENABLED — exporting to OTEL_EXPORTER_OTLP_ENDPOINT'
      : 'agentops worker: tracing disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)',
  );

  const worker = await createWorker({
    taskQueue: 'agentops-devcycle',
    activities,
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE,
    tracing,
  });

  console.log('agentops worker started on task queue "agentops-devcycle"');
  try {
    await worker.run();
  } finally {
    await tracing?.shutdown();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
