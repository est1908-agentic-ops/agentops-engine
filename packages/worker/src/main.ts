import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node';
import { Pool } from 'pg';
import {
  createActivities,
  InMemoryFiledFindingStore,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
  loadManagedProjectRegistry,
  MemoryWorkspaceManager,
  PostgresFiledFindingStore,
  PostgresManagedProjectStore,
  PostgresStatsStore,
  PostgresTierStore,
  PostgresEngineSettingsStore,
  ensureSelfHealSchedule,
  type SelfHealScheduleClient,
  SpawnGitCommandRunner,
  WorkspaceManager,
  type FiledFindingStore,
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
  ProcessCliRunner,
  RateWindowedBackend,
  RateWindowLimiter,
  StubBackend,
  type AgentBackend,
  type BatchV1ApiLike,
  type K8sJobRunnerOptions,
} from '@agentops/backends';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { ENGINE_QUEUE, LEGACY_ENGINE_QUEUE } from '@agentops/contracts';
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
import { DEFAULT_TIERS } from '@agentops/policies';
import type { DevCycleActivities, PlatformActivities } from '@agentops/workflows';
import { createWorker } from './create-worker';
import { ensureReconcileSchedule, type ScheduleClientLike } from './ensure-reconcile-schedule';

import { ensureSearchAttributes, type OperatorConnectionLike } from './ensure-search-attributes';
import { setupTracing } from './tracing';

export interface ActivityWiring {
  scm: ScmPort;
  tracker: TrackerPort;
  workspaces: Workspaces;
}

export function buildActivityDependencies(
  registry: ResolvedProjectEntry[],
  workspacesDir?: string,
  cacheDir?: string,
): ActivityWiring {
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
  return { scm, tracker, workspaces: new WorkspaceManager({ resolveGit, cloneUrl: githubCloneUrl, workspacesDir, cacheDir }) };
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

// WorkspaceManager creates each task workspace as a `git worktree` of a shared
// per-repo base clone kept under this cache dir. Two things depend on it being
// a persistent, shared PVC mounted at the SAME path in both the engine-worker
// pod and every K8s Job pod (charts/engine/templates/deployment.yaml mounts the
// workspace-cache PVC here, and buildJobRunnerOptions mounts it into Job pods):
//   1. Persistence -- the base clone must survive a worker redeploy. It used to
//      default to the worker's ephemeral home (~/.agentops/cache), so shipping
//      any new worker image wiped every base clone and orphaned every worktree
//      on the (persistent) tasks PVC -- their `.git` pointed at a gitdir that no
//      longer existed. See issue-broccoli-94 (2026-07-12).
//   2. Cross-pod resolution -- a worktree's `.git` file points at
//      <cacheDir>/<repo>/.git/worktrees/<taskId>. The agent commits inside the
//      Job pod (implement.md tells it to `git add`/`git commit`), so the Job pod
//      must see that gitdir too; otherwise git can't resolve the worktree and
//      the agent falls back to `git init` on `master`, leaving nothing on
//      agentops/<taskId> for pushBranch to push.
export function cacheMountPath(): string {
  return process.env.CACHE_MOUNT_PATH ?? '/workspace/cache';
}

// Only in-cluster runAgent calls go through K8sJobRunner (see buildBackends
// below) -- local/dev mode spawns the CLI in-process via ProcessCliRunner, so
// there's no separate Job pod to line up with and the WorkspaceManager
// defaults (home dir) are fine.
export function resolveWorkspacesDir(inCluster: boolean): string | undefined {
  return inCluster ? workspaceMountPath() : undefined;
}

export function resolveCacheDir(inCluster: boolean): string | undefined {
  return inCluster ? cacheMountPath() : undefined;
}

export function buildJobRunnerOptions(
  batchApi: BatchV1ApiLike,
  opts: { authSecretName?: string; serviceAccountName?: string; additionalSecretNames?: string[]; podLabels?: Record<string, string> } = {},
): K8sJobRunnerOptions {
  return {
    namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
    workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
    workspaceMountPath: workspaceMountPath(),
    // The base clone a worktree links back to lives here; the agent commits in
    // the Job pod, so it needs the same cache PVC mounted at the same path the
    // worker created the worktree under (see cacheMountPath above).
    cachePvcName: process.env.CACHE_PVC_NAME ?? 'workspace-cache',
    cacheMountPath: cacheMountPath(),
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
// (see RateWindowLimiter). Built once per envPrefix and passed to every
// backend entry that shares that provider account (claude + platform both
// draw on CLAUDE_*) so they share one counter -- constructing a fresh
// limiter per entry would silently double the effective ceiling.
function buildRateWindowLimiter(envPrefix: string): RateWindowLimiter | undefined {
  const maxCalls = Number(process.env[`${envPrefix}_RATE_WINDOW_MAX_CALLS`]);
  const windowMs = Number(process.env[`${envPrefix}_RATE_WINDOW_MS`]);
  if (!Number.isFinite(maxCalls) || maxCalls <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return undefined;
  }
  return new RateWindowLimiter({ maxCalls, windowMs });
}

function wrapWithRateWindow(
  backend: AgentBackend,
  limiter: RateWindowLimiter | undefined,
  name: string,
): AgentBackend {
  return limiter ? new RateWindowedBackend(backend, limiter, name) : backend;
}

// In-cluster tasks fail two ways when these are missing or still placeholders:
// an ImagePullBackOff that eats the whole activity timeout before surfacing
// anything (AGENT_RUNNER_IMAGE), or a real Job that starts but every call
// 401s (*_AUTH_SECRET_NAME -- an unset secret name means
// envFrom gets no entry at all, not an empty one). Both are worker-startup
// misconfigurations, not per-task failures, so they belong here, checked
// once, loud, before the worker ever claims a task -- not discovered
// piecemeal days later as a string of confusing individual task failures.
export function assertLiveBackendConfig(env: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if (!env.AGENT_RUNNER_IMAGE || env.AGENT_RUNNER_IMAGE.includes('CHANGEME')) {
    missing.push('AGENT_RUNNER_IMAGE (unset or still the placeholder image)');
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
  if (!inCluster) {
    const claudeRateWindowLimiter = buildRateWindowLimiter('CLAUDE');
    return {
      stub: new StubBackend(),
      claude: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), claudeRateWindowLimiter, 'claude'),
      pi: wrapWithRateWindow(new ProcessCliRunner(piSpec), buildRateWindowLimiter('PI'), 'pi'),
      // Same CLI/model/rate window as claude (see the in-cluster branch below for why).
      platform: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), claudeRateWindowLimiter, 'platform'),
    };
  }

  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batchApi = batchApiFromClient(kc.makeApiClient(BatchV1Api));
  const claudeRateWindowLimiter = buildRateWindowLimiter('CLAUDE');

  return {
    stub: new StubBackend(),
    // claude and platform now share one auth secret and one rate window --
    // see the platform entry's comment below for why. pi's stays separate:
    // its env vars are provider-dependent (images/agent-runner/Dockerfile),
    // not guaranteed to be the same shape as claude's.
    claude: wrapWithRateWindow(
      new K8sJobRunner(claudeSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME })),
      claudeRateWindowLimiter,
      'claude',
    ),
    pi: wrapWithRateWindow(
      new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
      buildRateWindowLimiter('PI'),
      'pi',
    ),
    // Same CLI/model/credential/rate-window limiter as claude (they share one
    // Anthropic subscription window, deliberately -- see
    // docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md
    // and its 3fade45 correction), plus this role's own K8s identity: a
    // dedicated ServiceAccount (read-only cluster RBAC), an extra secret
    // (Temporal/Grafana credentials, once agentops-platform supplies
    // platformAgentSecretName), and a pod label the platform-agent
    // NetworkPolicy selects on. No rate-limit fallback wrapper -- that's for
    // z.ai's 429s, not relevant on Anthropic.
    platform: wrapWithRateWindow(
      new K8sJobRunner(
        claudeSpec,
        buildJobRunnerOptions(batchApi, {
          authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME,
          serviceAccountName: process.env.PLATFORM_AGENT_SERVICE_ACCOUNT,
          additionalSecretNames: process.env.PLATFORM_AGENT_SECRET_NAME ? [process.env.PLATFORM_AGENT_SECRET_NAME] : undefined,
          podLabels: { 'agentops/role': 'platform-agent' },
        }),
      ),
      claudeRateWindowLimiter,
      'platform',
    ),
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

export async function buildFiledFindingStore(): Promise<FiledFindingStore> {
  const host = process.env.ENGINE_DB_HOST;
  if (!host) {
    return new InMemoryFiledFindingStore();
  }
  const pool = new Pool({
    host,
    port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
    database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
    user: process.env.ENGINE_DB_USER ?? 'temporal',
    password: process.env.ENGINE_DB_PASSWORD,
  });
  const store = new PostgresFiledFindingStore(pool);
  await store.ensureSchema();
  return store;
}

// Global tier table (SP3-A). Loaded from Postgres at startup and re-read on a
// 60s interval so a Mission Control tier edit applies to new runAgent calls
// within a minute -- no pod rollout needed. The returned object is mutated
// in place on each refresh; the activity reads deps.globalTiers per call, so
// it sees the latest map without re-wiring. Returns a plain (mutable) object
// + a cleanup fn for the refresh timer. When no DB is configured, returns
// undefined and resolveTier falls back to DEFAULT_TIERS (the hardcoded seed).
const TIER_REFRESH_INTERVAL_MS = 60_000;

export async function buildGlobalTiers(
  pool: Pool | undefined,
): Promise<{ tiers: Record<string, import('@agentops/contracts').ModelRef[]> | undefined; stop: () => void }> {
  if (!pool) {
    return { tiers: undefined, stop: () => {} };
  }
  const store = new PostgresTierStore(pool);
  await store.ensureSchema();
  const seeded = await store.seedIfEmpty();
  if (seeded) {
    console.log('agentops worker: tiers table seeded from DEFAULT_TIERS (first boot)');
  }
  // Pre-seed with DEFAULT_TIERS so the first refresh failing (DB transiently
  // unreachable at boot) leaves the hardcoded defaults in place rather than
  // an empty object that would make every resolveTier throw. The catch in
  // refresh() then genuinely "keeps the previous map" from call one.
  const tiers: Record<string, import('@agentops/contracts').ModelRef[]> = { ...DEFAULT_TIERS };
  const refresh = async () => {
    try {
      const map = await store.loadAll();
      // Mutate in place so the activity's deps.globalTiers reference sees the
      // new entries without re-wiring. Clear + repopulate.
      for (const key of Object.keys(tiers)) delete tiers[key];
      for (const [k, v] of map.entries()) tiers[k] = v;
    } catch (err) {
      console.warn('agentops worker: tier refresh failed (keeping previous map)', err);
    }
  };
  await refresh();
  const timer = setInterval(refresh, TIER_REFRESH_INTERVAL_MS);
  // Don't keep the event loop alive solely for the refresh timer -- the
  // worker's own run loop is the liveness signal.
  if (typeof timer.unref === 'function') timer.unref();
  return { tiers, stop: () => clearInterval(timer) };
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

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
  const registry = managedProjectDeps ? await loadManagedProjectRegistry(managedProjectDeps) : [];
  const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const { scm, tracker, workspaces } = buildActivityDependencies(
    registry,
    resolveWorkspacesDir(inCluster),
    resolveCacheDir(inCluster),
  );
  console.log(
    registry.length > 0
      ? `agentops worker: LIVE mode — ${registry.length} project(s) registered: ${registry
          .map((entry) => `${entry.project} (${entry.repo})`)
          .join(', ')} — real GitHub + real agent CLIs, will spend tokens and open real PRs`
      : 'agentops worker: DEMO mode (no managed-project DB configured) — in-memory ports + stub backend only',
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

  const filedFindings = await buildFiledFindingStore();
  console.log(
    filedFindings instanceof PostgresFiledFindingStore
      ? 'agentops worker: filed_findings persisted to Postgres (ENGINE_DB_HOST set)'
      : 'agentops worker: filed_findings in-memory only (ENGINE_DB_HOST not set)',
  );

  const { tiers: globalTiers, stop: stopTierRefresh } = await buildGlobalTiers(enginePool);
  console.log(
    globalTiers
      ? `agentops worker: global tiers loaded from Postgres (${Object.keys(globalTiers).length} tiers, 60s refresh)`
      : 'agentops worker: global tiers from DEFAULT_TIERS (no DB -- hardcoded seed)',
  );

  // Build a Temporal client for Schedule management (ConfigSync activities).
  // Uses the same address/namespace as the worker connection when available.
  let scheduleClient: import('@agentops/activities').ScheduleClientLike | undefined;
  let workflowClient: import('@agentops/activities').WorkflowClientLike | undefined;
  try {
    const c: import('@temporalio/client').Connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    const tc = new Client({ connection: c, namespace: process.env.TEMPORAL_NAMESPACE });
    scheduleClient = tc.schedule as unknown as import('@agentops/activities').ScheduleClientLike;
    workflowClient = tc.workflow as unknown as import('@agentops/activities').WorkflowClientLike;
    // Ensure the custom search attributes exist before the reconciler ever
    // creates a Schedule (which stamps them) -- Temporal rejects a create that
    // references an unregistered attribute. Idempotent, so it's safe on every
    // boot. A failure here isn't fatal (the worker can still serve devCycle);
    // warn so a genuinely broken namespace surfaces without blocking startup.
    try {
      await ensureSearchAttributes(c as unknown as OperatorConnectionLike, process.env.TEMPORAL_NAMESPACE);
      console.log('agentops worker: custom search attributes ensured (project, agentName, workflowType)');
    } catch (err) {
      console.warn('agentops worker: failed to ensure search attributes — reconcile may reject Schedule creates', err);
    }
    try {
      await ensureReconcileSchedule(tc.schedule as unknown as ScheduleClientLike, ENGINE_QUEUE);
      console.log('agentops worker: reconcile:all periodic schedule ensured');
    } catch (err) {
      console.warn('agentops worker: failed to ensure reconcile:all schedule', err);
    }
    try {
      if (!enginePool) {
        console.log('agentops worker: self-heal schedule skipped (no ENGINE_DB_HOST — settings live in DB only)');
      } else {
        const engineSettingsStore = new PostgresEngineSettingsStore(enginePool);
        await engineSettingsStore.ensureSchema();
        const seeded = await engineSettingsStore.seedIfEmpty();
        if (seeded) {
          console.log('agentops worker: engine_settings seeded with defaults (first boot)');
        }
        const selfHealOpts = await engineSettingsStore.getSelfHeal();
        await ensureSelfHealSchedule(tc.schedule as unknown as SelfHealScheduleClient, ENGINE_QUEUE, selfHealOpts);
        console.log(`agentops worker: self-heal schedule ensured (enabled=${selfHealOpts.enabled})`);
      }
    } catch (err) {
      console.warn('agentops worker: failed to ensure self-heal schedule', err);
    }
  } catch {
    // In test or no Temporal, schedule ops will no-op or be injected by tests.
  }

  const activities: DevCycleActivities & PlatformActivities = createActivities({
    backends: buildBackends(inCluster),
    tracker,
    scm,
    stats,
    stageResults: new InMemoryStageResultStore(),
    workspaces,
    prompts: new PromptPack(),
    registry,
    globalTiers,
    filedFindings,
    scheduleClient,
    taskQueue: ENGINE_QUEUE,
    workflowClient,
  });

  const tracing = setupTracing();
  console.log(
    tracing
      ? 'agentops worker: tracing ENABLED — exporting to OTEL_EXPORTER_OTLP_ENDPOINT'
      : 'agentops worker: tracing disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)',
  );

  const worker = await createWorker({ taskQueue: ENGINE_QUEUE, activities, connection, namespace: process.env.TEMPORAL_NAMESPACE, tracing });
  const legacyWorker = await createWorker({ taskQueue: LEGACY_ENGINE_QUEUE, activities, connection, namespace: process.env.TEMPORAL_NAMESPACE, tracing });
  console.log(`agentops worker started on "${ENGINE_QUEUE}" (+ legacy "${LEGACY_ENGINE_QUEUE}" during cutover)`);
  try {
    await Promise.all([worker.run(), legacyWorker.run()]);
  } finally {
    stopTierRefresh();
    await tracing?.shutdown();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
