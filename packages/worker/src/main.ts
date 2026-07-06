import { NativeConnection } from '@temporalio/worker';
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
  loadProjectRegistry,
  MemoryWorkspaceManager,
  SpawnGitCommandRunner,
  WorkspaceManager,
  type Workspaces,
} from '@agentops/activities';

loadEnv();
import {
  batchApiFromClient,
  createClaudeCliSpec,
  createPiCliSpec,
  K8sJobRunner,
  ProcessCliRunner,
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
import type { DevCycleActivities } from '@agentops/workflows';
import { createWorker } from './create-worker';

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
  authSecretName: string | undefined,
): K8sJobRunnerOptions {
  return {
    namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
    workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
    workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
    authSecretName,
    imagePullSecretName: process.env.IMAGE_PULL_SECRET_NAME,
    batchApi,
  };
}

export function buildBackends(inCluster: boolean): Record<string, AgentBackend> {
  const agentImage =
    process.env.AGENT_RUNNER_IMAGE ?? 'ghcr.io/CHANGEME/agentops-engine/agent-runner:CHANGEME';
  const claudeSpec = createClaudeCliSpec({ image: agentImage });
  const piSpec = createPiCliSpec({ image: agentImage });

  if (!inCluster) {
    return {
      stub: new StubBackend(),
      claude: new ProcessCliRunner(claudeSpec),
      pi: new ProcessCliRunner(piSpec),
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
    claude: new K8sJobRunner(claudeSpec, buildJobRunnerOptions(batchApi, process.env.CLAUDE_AUTH_SECRET_NAME)),
    pi: new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, process.env.PI_AUTH_SECRET_NAME)),
  };
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

  const activities: DevCycleActivities = createActivities({
    backends: buildBackends(inCluster),
    tracker,
    scm,
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces,
    prompts: new PromptPack(),
  });

  const worker = await createWorker({
    taskQueue: 'agentops-devcycle',
    activities,
    connection,
  });

  console.log('agentops worker started on task queue "agentops-devcycle"');
  await worker.run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
