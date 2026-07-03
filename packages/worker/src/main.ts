import { NativeConnection } from '@temporalio/worker';
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
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
} from '@agentops/backends';
import {
  createGithubPorts,
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

export function buildActivityDependencies(githubToken: string | undefined): ActivityWiring {
  if (!githubToken) {
    return { scm: new MemoryScmPort(), tracker: new MemoryTrackerPort(), workspaces: new MemoryWorkspaceManager() };
  }
  const git = new SpawnGitCommandRunner({ authToken: () => githubToken });
  const { scm, tracker } = createGithubPorts(githubToken, git);
  return { scm, tracker, workspaces: new WorkspaceManager({ git, cloneUrl: githubCloneUrl }) };
}

export function buildBackends(inCluster: boolean): Record<string, AgentBackend> {
  const agentImage =
    process.env.AGENT_RUNNER_IMAGE ?? 'ghcr.io/CHANGEME/agentops-engine/agent-claude:CHANGEME';
  const claudeSpec = createClaudeCliSpec({ image: agentImage });
  const piSpec = createPiCliSpec();

  if (!inCluster) {
    return {
      stub: new StubBackend(),
      claude: new ProcessCliRunner(claudeSpec),
      pi: new ProcessCliRunner(piSpec),
    };
  }

  const kc = new KubeConfig();
  kc.loadFromCluster();

  return {
    stub: new StubBackend(),
    claude: new K8sJobRunner(claudeSpec, {
      namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
      workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
      workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
      batchApi: batchApiFromClient(kc.makeApiClient(BatchV1Api)),
    }),
    pi: new ProcessCliRunner(piSpec),
  };
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const githubToken = process.env.GITHUB_TOKEN;
  const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const { scm, tracker, workspaces } = buildActivityDependencies(githubToken);
  console.log(
    githubToken
      ? 'agentops worker: LIVE mode (GITHUB_TOKEN set) — real GitHub + real agent CLIs, will spend tokens and open real PRs'
      : 'agentops worker: DEMO mode (no GITHUB_TOKEN) — in-memory ports + stub backend only',
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
