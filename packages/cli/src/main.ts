import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { Pool } from 'pg';
import {
  loadEnv,
  loadProjectRegistry,
  PostgresManagedProjectStore,
  resolveManagedProjectEntry,
  resolveProjectConfig,
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
  const managedProjectDeps = buildCliManagedProjectDeps();
  const scm = await buildStartScmPortWithManagedProjects(managedProjectDeps, loadProjectRegistry(), project, repo);
  const config = await resolveProjectConfig(managedProjectDeps, scm, repo);
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

export function controlBaseUrl(): string {
  return process.env.CONTROL_BASE_URL ?? 'http://localhost:3001';
}

export function controlCrudHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.CONTROL_CRUD_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

export async function buildControlRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${controlBaseUrl()}${path}`, {
    method,
    headers: controlCrudHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text; // keep raw text if it isn't JSON (e.g. a 204 empty body)
    }
  }
  return { status: res.status, body: parsed };
}

function parseConfigArg(configJson: string | undefined): unknown {
  if (configJson === undefined) {
    return undefined;
  }
  return configJson === 'null' ? null : JSON.parse(configJson);
}

async function cmdProjectAdd(flags: Record<string, string>): Promise<void> {
  const { project, repo, token, config: configJson } = flags;
  if (!project || !repo || !token) {
    throw new Error('usage: engine project add --project <name> --repo <owner/repo> --token <token> [--config <json>]');
  }
  const { status, body } = await buildControlRequest('POST', '/api/projects', { project, repo, token, config: parseConfigArg(configJson) });
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectList(): Promise<void> {
  const { status, body } = await buildControlRequest('GET', '/api/projects');
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectShow(flags: Record<string, string>): Promise<void> {
  const { repo } = flags;
  if (!repo) {
    throw new Error('usage: engine project show --repo <owner/repo>');
  }
  const { status, body } = await buildControlRequest('GET', `/api/projects/${encodeURIComponent(repo)}`);
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectUpdate(flags: Record<string, string>): Promise<void> {
  const { repo, token, config: configJson } = flags;
  if (!repo) {
    throw new Error('usage: engine project update --repo <owner/repo> [--token <token>] [--config <json>|null]');
  }
  if (token === undefined && configJson === undefined) {
    throw new Error('usage: engine project update needs at least one of --token or --config');
  }
  const payload: Record<string, unknown> = {};
  if (token !== undefined) payload.token = token;
  if (configJson !== undefined) payload.config = parseConfigArg(configJson);
  const { status, body } = await buildControlRequest('PUT', `/api/projects/${encodeURIComponent(repo)}`, payload);
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectRemove(flags: Record<string, string>): Promise<void> {
  const { repo } = flags;
  if (!repo) {
    throw new Error('usage: engine project remove --repo <owner/repo>');
  }
  const { status, body } = await buildControlRequest('DELETE', `/api/projects/${encodeURIComponent(repo)}`);
  console.log(`status ${status}`);
  if (body) {
    console.log(JSON.stringify(body, null, 2));
  }
}

export async function cmdProject(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'add') {
    return cmdProjectAdd(parseFlags(rest));
  }
  if (subcommand === 'list') {
    return cmdProjectList();
  }
  if (subcommand === 'show') {
    return cmdProjectShow(parseFlags(rest));
  }
  if (subcommand === 'update') {
    return cmdProjectUpdate(parseFlags(rest));
  }
  if (subcommand === 'remove') {
    return cmdProjectRemove(parseFlags(rest));
  }
  throw new Error('usage: engine project <add|list|show|update|remove> ...');
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
  } else if (command === 'project') {
    await cmdProject(rest);
  } else {
    console.error('usage: cli <start|signal|state|project> ...');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
