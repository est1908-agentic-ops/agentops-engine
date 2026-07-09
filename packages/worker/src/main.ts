import { NativeConnection } from '@temporalio/worker';
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node';
import { Pool } from 'pg';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
  loadManagedProjectRegistry,
  loadProjectRegistry,
  MemoryWorkspaceManager,
  PostgresManagedProjectStore,
  PostgresStatsStore,
  SpawnGitCommandRunner,
  WorkspaceManager,
  type ManagedProjectRegistryDeps,
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
  RateLimitFallbackBackend,
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
  LinearGraphqlClient,
  LinearTrackerPort,
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

export function buildActivityDependencies(registry: ResolvedProjectEntry[], workspacesDir?: string): ActivityWiring {
  if (registry.length === 0) {
    return { scm: new MemoryScmPort(), tracker: new MemoryTrackerPort(), workspaces: new MemoryWorkspaceManager() };
  }
  const entries = registry.map((entry) => {
    const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
    // SCM/git are always GitHub -- PRs and worktrees live on the repo side
    // regardless of which tracker filed the task (see the Linear trigger
    // design doc). Only the tracker implementation varies per entry.
    const { scm, tracker: githubTracker } = createGithubPorts(entry.token, git);
    if (entry.trackerType !== 'linear') {
      return { repo: entry.repo, scm, tracker: githubTracker, git };
    }
    if (!entry.linearToken) {
      throw new Error(`buildActivityDependencies: project "${entry.project}" is linear-tracked but has no resolved linearToken`);
    }
    const tracker = new LinearTrackerPort(new LinearGraphqlClient(entry.linearToken));
    return { repo: entry.repo, linearTeamKey: entry.linearTeamKey, scm, tracker, git };
  });
  const { scm, tracker, resolveGit } = createProjectScopedPorts(entries);
  return { scm, tracker, workspaces: new WorkspaceManager({ resolveGit, cloneUrl: githubCloneUrl, workspacesDir }) };
}

/**
 * DB-registered projects take precedence over a static entry for the same
 * repo (docs/superpowers/specs/2026-07-08-managed-project-registry-design.md
 * §6) -- filter the static list down to repos the managed registry doesn't
 * already cover, then put managed entries first for readability in logs.
 */
export function mergeStaticAndManagedRegistries(
  staticRegistry: ResolvedProjectEntry[],
  managedRegistry: ResolvedProjectEntry[],
): ResolvedProjectEntry[] {
  const managedRepos = new Set(managedRegistry.map((entry) => entry.repo));
  return [...managedRegistry, ...staticRegistry.filter((entry) => !managedRepos.has(entry.repo))];
}

function buildManagedProjectDeps(pool: Pool | undefined): ManagedProjectRegistryDeps | undefined {
  const privateKey = process.env.PROJECT_CREDENTIAL_PRIVATE_KEY;
  if (!pool || !privateKey) {
    return undefined;
  }
  return { store: new PostgresManagedProjectStore(pool), privateKey };
}

// The workspace-tasks PVC is mounted at this path in both the engine-worker
// pod (see charts/engine/templates/deployment.yaml) and every K8s Job pod it
// launches (K8sJobRunnerOptions.workspaceMountPath below). WorkspaceManager
// must create task workspaces under this same path -- otherwise a
// workspaceRef it hands to K8sJobRunner points at a directory that only
// exists on the engine-worker pod's own filesystem, and the Job container's
// workingDir doesn't exist.
export function workspaceMountPath(): string {
  return process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks';
}

// Only in-cluster runAgent calls go through K8sJobRunner (see buildBackends
// below) -- local/dev mode spawns the CLI in-process via ProcessCliRunner, so
// there's no separate Job pod to line up with and the WorkspaceManager
// default (home dir) is fine.
export function resolveWorkspacesDir(inCluster: boolean): string | undefined {
  return inCluster ? workspaceMountPath() : undefined;
}

export function buildJobRunnerOptions(
  batchApi: BatchV1ApiLike,
  opts: { authSecretName?: string; serviceAccountName?: string; additionalSecretNames?: string[]; podLabels?: Record<string, string> } = {},
): K8sJobRunnerOptions {
  return {
    namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
    workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
    workspaceMountPath: workspaceMountPath(),
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

// Reacts to a real provider-side rate limit (ProviderRateLimitedError),
// unlike wrapWithRateWindow's proactive local quota check -- see
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
// Unset env var (the default) means no fallback, same "off by default"
// convention as the rate window.
function wrapWithRateLimitFallback(backend: AgentBackend, envPrefix: string, name: string): AgentBackend {
  const fallbackModel = process.env[`${envPrefix}_RATE_LIMIT_FALLBACK_MODEL`];
  if (!fallbackModel) {
    return backend;
  }
  return new RateLimitFallbackBackend(backend, fallbackModel, name);
}

// In-cluster tasks fail two ways when these are missing or still placeholders:
// an ImagePullBackOff that eats the whole activity timeout before surfacing
// anything (AGENT_RUNNER_IMAGE), or a real Job that starts but every call
// 401s (LITELLM_API_KEY, *_AUTH_SECRET_NAME -- an unset secret name means
// envFrom gets no entry at all, not an empty one). Both are worker-startup
// misconfigurations, not per-task failures, so they belong here, checked
// once, loud, before the worker ever claims a task -- not discovered
// piecemeal days later as a string of confusing individual task failures.
export function assertLiveBackendConfig(env: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if (!env.AGENT_RUNNER_IMAGE || env.AGENT_RUNNER_IMAGE.includes('CHANGEME')) {
    missing.push('AGENT_RUNNER_IMAGE (unset or still the placeholder image)');
  }
  if (!env.LITELLM_API_KEY) {
    missing.push('LITELLM_API_KEY');
  }
  if (!env.CLAUDE_AUTH_SECRET_NAME) {
    missing.push('CLAUDE_AUTH_SECRET_NAME');
  }
  if (!env.PI_AUTH_SECRET_NAME) {
    missing.push('PI_AUTH_SECRET_NAME');
  }
  if (missing.length > 0) {
    throw new Error(
      `refusing to start in-cluster: missing or placeholder backend config:\n- ${missing.join('\n- ')}`,
    );
  }
}

export function buildBackends(inCluster: boolean): Record<string, AgentBackend> {
  if (inCluster) {
    assertLiveBackendConfig(process.env);
  }
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
      pi: wrapWithRateLimitFallback(wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'pi'), 'PI', 'pi'),
      platform: wrapWithRateLimitFallback(
        wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'platform'),
        'PI',
        'platform',
      ),
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
    pi: wrapWithRateLimitFallback(
      wrapWithRateWindow(
        new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
        'PI',
        'pi',
      ),
      'PI',
      'pi',
    ),
    platform: wrapWithRateLimitFallback(
      wrapWithRateWindow(
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
      'PI',
      'platform',
    ),
    litellm,
  };
}

export async function buildStatsStore(): Promise<StatsStore> {
  const host = process.env.ENGINE_DB_HOST;
  if (!host) {
    return new InMemoryStatsStore();
  }
  const pool = new Pool({
    host,
    port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
    database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
    user: process.env.ENGINE_DB_USER ?? 'temporal',
    password: process.env.ENGINE_DB_PASSWORD,
  });
  const store = new PostgresStatsStore(pool);
  await store.ensureSchema();
  return store;
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const staticRegistry = loadProjectRegistry();
  const enginePool = process.env.ENGINE_DB_HOST
    ? new Pool({
        host: process.env.ENGINE_DB_HOST,
        port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
        database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
        user: process.env.ENGINE_DB_USER ?? 'temporal',
        password: process.env.ENGINE_DB_PASSWORD,
      })
    : undefined;
  const managedProjectDeps = buildManagedProjectDeps(enginePool);
  if (enginePool && !managedProjectDeps) {
    console.warn('agentops worker: ENGINE_DB_HOST set but PROJECT_CREDENTIAL_PRIVATE_KEY missing — managed-project DB lookup disabled');
  }
  if (managedProjectDeps) {
    await managedProjectDeps.store.ensureSchema();
  }
  const managedRegistry = managedProjectDeps ? await loadManagedProjectRegistry(managedProjectDeps) : [];
  const registry = mergeStaticAndManagedRegistries(staticRegistry, managedRegistry);
  const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const { scm, tracker, workspaces } = buildActivityDependencies(registry, resolveWorkspacesDir(inCluster));
  console.log(
    registry.length > 0
      ? `agentops worker: LIVE mode — ${registry.length} project(s) registered: ${registry
          .map((entry) => `${entry.project} (${entry.repo})`)
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
      ? 'agentops worker: agent_run_stats persisted to Postgres (ENGINE_DB_HOST set)'
      : 'agentops worker: agent_run_stats in-memory only (ENGINE_DB_HOST not set)',
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
