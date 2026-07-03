import { NativeConnection } from '@temporalio/worker';
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
import { ClaudeBackend, PiBackend, StubBackend } from '@agentops/backends';
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

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const githubToken = process.env.GITHUB_TOKEN;
  const { scm, tracker, workspaces } = buildActivityDependencies(githubToken);
  console.log(
    githubToken
      ? 'agentops worker: LIVE mode (GITHUB_TOKEN set) — real GitHub + real agent CLIs, will spend tokens and open real PRs'
      : 'agentops worker: DEMO mode (no GITHUB_TOKEN) — in-memory ports + stub backend only',
  );

  const activities: DevCycleActivities = createActivities({
    backends: { stub: new StubBackend(), claude: new ClaudeBackend(), pi: new PiBackend() },
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
