import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Client } from '@temporalio/client';
import { loadProjectConfig, resolveManagedProjectEntry, type ManagedProjectRegistryDeps } from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';
import { parseIssueLabeledEvent } from './parse-issue-labeled';
import { startDevCycleForIssue } from './start-dev-cycle';
import { verifyGithubSignature } from './verify-signature';

export interface GatewayDeps {
  client: Client;
  taskQueue: string;
  webhookSecret: string;
  triggerLabel: string;
  registry: ResolvedProjectEntry[];
  // Injectable so tests don't need a live GitHub client — the real caller
  // (main.ts) builds a GithubScmPort from the entry's token.
  buildScm: (entry: ResolvedProjectEntry) => ScmPort;
  // Undefined when ENGINE_DB_HOST/PROJECT_CREDENTIAL_PRIVATE_KEY aren't set —
  // every lookup falls through to `registry` only, same as before this field existed.
  managedProjectDeps?: ManagedProjectRegistryDeps;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createGatewayServer(deps: GatewayDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(deps, req, res);
  });
}

async function handleRequest(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhooks/github') {
    res.writeHead(404).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-hub-signature-256'];

  if (!verifyGithubSignature(rawBody, typeof signature === 'string' ? signature : undefined, deps.webhookSecret)) {
    res.writeHead(401).end('invalid signature');
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.writeHead(400).end('invalid JSON');
    return;
  }

  const githubEvent = req.headers['x-github-event'];
  const event = parseIssueLabeledEvent(typeof githubEvent === 'string' ? githubEvent : undefined, payload, deps.triggerLabel);
  if (!event) {
    // Not an event this gateway acts on (wrong event type, wrong action, or a
    // different label) — acknowledge so GitHub doesn't retry, but do nothing.
    res.writeHead(204).end();
    return;
  }

  const entry = await resolveManagedProjectEntry(deps.managedProjectDeps, deps.registry, event.repo);
  if (!entry) {
    console.warn(`gateway: no project registered for repo "${event.repo}" — ignoring labeled event`);
    res.writeHead(202).end('no project registered for this repo');
    return;
  }

  try {
    const scm = deps.buildScm(entry);
    const config = await loadProjectConfig(scm, entry.repo);
    const result = await startDevCycleForIssue(deps.client, deps.taskQueue, entry.project, event, config);
    console.log(
      result.started
        ? `gateway: started devCycle ${result.taskId} for ${event.issueRef}`
        : `gateway: devCycle ${result.taskId} already running for ${event.issueRef} — ignored duplicate label event`,
    );
    res.writeHead(202).end(JSON.stringify(result));
  } catch (err) {
    console.error(`gateway: failed to start devCycle for ${event.issueRef}:`, err);
    res.writeHead(500).end('failed to start task');
  }
}
