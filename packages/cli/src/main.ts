import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { Pool } from 'pg';
import {
  loadEnv,
  loadProjectConfig,
  loadProjectRegistry,
  PostgresManagedProjectStore,
  resolveManagedProjectEntry,
  SpawnGitCommandRunner,
  type ManagedProjectRegistryDeps,
} from '@agentops/activities';

loadEnv();
import type { ResolvedProjectEntry, TaskInput } from '@agentops/contracts';
import { createGithubPorts, MemoryScmPort, type ScmPort } from '@agentops/ports';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';

const TASK_QUEUE = 'agentops-devcycle';

export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`usage: missing value for --${key}`);
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

export function seedDemoAgentopsConfig(scm: MemoryScmPort, repo: string): void {
  const stubRoute = { backend: 'stub', model: 'stub-v1' };
  scm.seedFile(
    repo,
    'agentops.json',
    JSON.stringify({
      fastVerifyCommands: ['pnpm lint'],
      fullVerifyCommands: ['pnpm test'],
      routing: {
        context: stubRoute,
        assess: stubRoute,
        design: stubRoute,
        plan: stubRoute,
        implement: stubRoute,
        full_verify: stubRoute,
        review: stubRoute,
      },
    }),
  );
}

export function resolveProjectEntry(
  registry: ResolvedProjectEntry[],
  project: string,
  repo: string,
): ResolvedProjectEntry {
  const entry = registry.find((candidate) => candidate.repo === repo);
  if (!entry) {
    throw new Error(`no project registered for repo "${repo}" — check the project registry`);
  }
  if (entry.project !== project) {
    throw new Error(`repo "${repo}" is registered under project "${entry.project}", not "${project}" — check --project`);
  }
  return entry;
}

export function buildStartScmPort(registry: ResolvedProjectEntry[], project: string, repo: string): ScmPort {
  if (registry.length === 0) {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, repo);
    return scm;
  }
  const entry = resolveProjectEntry(registry, project, repo);
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

/**
 * DB-first variant of buildStartScmPort: tries the managed-project registry
 * before the static one. `managedProjectDeps` is undefined when
 * ENGINE_DB_HOST/PROJECT_CREDENTIAL_PRIVATE_KEY aren't set -- falls straight
 * through to today's behavior in that case.
 */
export async function buildStartScmPortWithManagedProjects(
  managedProjectDeps: ManagedProjectRegistryDeps | undefined,
  registry: ResolvedProjectEntry[],
  project: string,
  repo: string,
): Promise<ScmPort> {
  if (registry.length === 0 && !managedProjectDeps) {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, repo);
    return scm;
  }
  const entry = await resolveManagedProjectEntry(managedProjectDeps, registry, repo);
  if (!entry) {
    throw new Error(`no project registered for repo "${repo}" — check the project registry`);
  }
  if (entry.project !== project) {
    throw new Error(`repo "${repo}" is registered under project "${entry.project}", not "${project}" — check --project`);
  }
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

function buildCliManagedProjectDeps(): ManagedProjectRegistryDeps | undefined {
  const host = process.env.ENGINE_DB_HOST;
  const privateKey = process.env.PROJECT_CREDENTIAL_PRIVATE_KEY;
  if (!host || !privateKey) {
    return undefined;
  }
  const pool = new Pool({
    host,
    port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
    database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
    user: process.env.ENGINE_DB_USER ?? 'temporal',
    password: process.env.ENGINE_DB_PASSWORD,
  });
  return { store: new PostgresManagedProjectStore(pool), privateKey };
}

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });
}

async function cmdStart(taskId: string, goal: string, project: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const scm = await buildStartScmPortWithManagedProjects(buildCliManagedProjectDeps(), loadProjectRegistry(), project, repo);
  const config = await loadProjectConfig(scm, repo);
  const input: TaskInput = { taskId, project, repo, issueRef, goal, config };
  const handle = await client.workflow.start(devCycle, { taskQueue: TASK_QUEUE, workflowId: taskId, args: [input] });
  console.log(`started ${handle.workflowId}`);
}

async function cmdSignal(taskId: string, signal: string, text?: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(taskId);
  if (signal === 'stop') {
    await handle.signal(stopSignal);
  } else if (signal === 'cancel') {
    await handle.signal(cancelSignal);
  } else if (signal === 'resume') {
    await handle.signal(resumeSignal);
  } else if (signal === 'clarify') {
    await handle.signal(clarifySignal, text ?? '');
  } else {
    throw new Error(`unknown signal: ${signal} (expected stop|cancel|resume|clarify)`);
  }
  console.log(`sent ${signal} to ${taskId}`);
}

async function cmdState(taskId: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(taskId);
  const state = await handle.query(stateQuery);
  console.log(JSON.stringify(state, null, 2));
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'start') {
    const flags = parseFlags(rest);
    const taskId = flags['task-id'] ?? randomUUID();
    const { goal, repo, project = 'default', issue } = flags;
    if (!goal || !repo) {
      throw new Error(
        'usage: engine start --goal <text> --repo <owner/repo> [--project <name>] [--issue <owner/repo#N>] [--task-id <id>]',
      );
    }
    await cmdStart(taskId, goal, project, repo, issue);
  } else if (command === 'signal') {
    const [taskId, signal, text] = rest;
    if (!taskId || !signal) {
      throw new Error('usage: cli signal <taskId> <stop|cancel|resume|clarify> [text]');
    }
    await cmdSignal(taskId, signal, text);
  } else if (command === 'state') {
    const [taskId] = rest;
    if (!taskId) {
      throw new Error('usage: cli state <taskId>');
    }
    await cmdState(taskId);
  } else {
    console.error('usage: cli <start|signal|state> ...');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
