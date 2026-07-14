import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Client } from '@temporalio/client';
import {
  resolveManagedProjectEntry,
  resolveManagedProjectEntryByLinearTeamKey,
  resolveProjectConfig,
  type ManagedProjectRegistryDeps,
} from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';
import type { ProjectWorkerParamsProvider } from './argocd-project-workers';
import { matchesLinearTriggerLabel, parseLinearIssueEvent } from './parse-linear-issue-event';
import { parseIssueTriggerEvent } from './parse-issue-labeled';
import { parsePushEvent } from './parse-push-event';
import { parsePrReviewEvent } from './parse-pr-review-event';
import { startConfigSync } from './start-config-sync';
import { startDevCycleForLinearIssue } from './start-dev-cycle-for-linear-issue';
import { startDevCycleForIssue } from './start-dev-cycle';
import { startDevCyclePrRepair } from './start-dev-cycle-pr-repair';  // added
import { isFreshLinearWebhook, verifyLinearSignature } from './verify-linear-signature';
import { verifyGithubSignature } from './verify-signature';

export interface GatewayDeps {
  client: Client;
  taskQueue: string;
  webhookSecret: string;
  triggerLabel: string;
  // Injectable so tests don't need a live GitHub client — the real caller
  // (main.ts) builds a GithubScmPort from the entry's token.
  buildScm: (entry: ResolvedProjectEntry) => ScmPort;
  // The only project registry -- DB-backed (managed_projects table). No
  // static-registry fallback exists anymore (see the Linear trigger design
  // doc's DB-only addendum); undefined means ENGINE_DB_HOST/
  // PROJECT_CREDENTIAL_PRIVATE_KEY aren't set, so every webhook is
  // acknowledged and ignored (nothing is registered anywhere).
  managedProjectDeps?: ManagedProjectRegistryDeps;
  // Undefined disables the /webhooks/linear route entirely (404) -- lets a
  // deployment with no Linear-tracked projects skip configuring a new
  // required secret, same as every existing GitHub-only gateway deployment.
  linearWebhookSecret?: string;
  // Serves the ArgoCD ApplicationSet plugin-generator route
  // (POST /api/v1/getparams.execute) with per-project worker specs read from
  // each project's agents.json. Both must be set or the route 404s (feature
  // off), same posture as the Linear route. The token gates the route
  // (ArgoCD sends `Authorization: Bearer <token>`).
  argocdParams?: ProjectWorkerParamsProvider;
  argocdPluginToken?: string;
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
    // handleRequest's own try/catch around the "start devCycle" calls only
    // covers the parts expected to fail (a bad token, Temporal unreachable).
    // This outer catch is the backstop for everything else -- an uncaught
    // throw in a parser/verifier (this process also serves the *other*
    // webhook route) would otherwise become an unhandled rejection that
    // crashes the whole gateway, not just this one request.
    handleRequest(deps, req, res).catch((err) => {
      console.error('gateway: unhandled error handling request', err);
      if (!res.headersSent) {
        res.writeHead(500).end('internal error');
      }
    });
  });
}

async function handleRequest(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/webhooks/github') {
    await handleGithubWebhook(deps, req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/webhooks/linear') {
    await handleLinearWebhook(deps, req, res);
    return;
  }

  // ArgoCD ApplicationSet plugin generator (project-worker-onboarding spec §5.2).
  if (req.method === 'POST' && req.url === '/api/v1/getparams.execute') {
    await handleArgoCdGetParams(deps, req, res);
    return;
  }

  res.writeHead(404).end();
}

async function handleArgoCdGetParams(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Off unless configured — 404 (same "not built here" posture as the Linear route).
  if (!deps.argocdPluginToken || !deps.argocdParams) {
    res.writeHead(404).end();
    return;
  }
  // Drain the request body regardless (ArgoCD posts {applicationSetName, input};
  // we take no input parameters). Do this before auth so the socket is consumed.
  await readRawBody(req);
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${deps.argocdPluginToken}`) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  try {
    const parameters = await deps.argocdParams.getParams();
    // ArgoCD plugin-generator response contract: { output: { parameters: [...] } }.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ output: { parameters } }));
  } catch (err) {
    console.error('gateway: failed to compute ArgoCD project-worker params', err);
    res.writeHead(500).end('failed to compute params');
  }
}

async function handleGithubWebhook(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const eventType = typeof githubEvent === 'string' ? githubEvent : undefined;

  const push = parsePushEvent(eventType, payload);
  if (push) {
    const entry = await resolveManagedProjectEntry(deps.managedProjectDeps, push.repo);
    if (!entry) {
      console.warn(`gateway: no project registered for repo "${push.repo}" — ignoring push event`);
      res.writeHead(202).end('no project registered for this repo');
      return;
    }
    try {
      const result = await startConfigSync(deps.client, deps.taskQueue, entry.project, entry.repo);
      console.log(`gateway: push → configSync for project "${entry.project}" (started=${result.started})`);
      res.writeHead(result.started ? 202 : 204).end();
    } catch (err) {
      console.error('gateway: failed to start configSync from push webhook', err);
      res.writeHead(500).end('failed to start configSync');
    }
    return;
  }

  const reviewEvent = parsePrReviewEvent(eventType, payload);
  if (reviewEvent) {
    const entry = await resolveManagedProjectEntry(deps.managedProjectDeps, reviewEvent.repo);
    if (!entry) {
      res.writeHead(202).end('no project registered');
      return;
    }
    try {
      const scm = deps.buildScm(entry);
      const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
      const result = await startDevCyclePrRepair(deps.client, deps.taskQueue, entry.project, reviewEvent, config);
      console.log(`gateway: ${result.started ? 'started' : 'already running'} devCyclePrRepair ${result.taskId} for ${reviewEvent.prRef}`);
      res.writeHead(202).end(JSON.stringify(result));
    } catch (err) {
      console.error('gateway: failed to start pr repair', err);
      res.writeHead(500).end('failed to start repair');
    }
    return;
  }

  const event = parseIssueTriggerEvent(eventType, payload, deps.triggerLabel);
  if (!event) {
    // Not an event this gateway acts on (wrong event type, wrong action, or a
    // different label) — acknowledge so GitHub doesn't retry, but do nothing.
    res.writeHead(204).end();
    return;
  }

  const entry = await resolveManagedProjectEntry(deps.managedProjectDeps, event.repo);
  if (!entry) {
    console.warn(`gateway: no project registered for repo "${event.repo}" — ignoring labeled event`);
    res.writeHead(202).end('no project registered for this repo');
    return;
  }

  try {
    const scm = deps.buildScm(entry);
    const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
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

async function handleLinearWebhook(deps: GatewayDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deps.linearWebhookSecret) {
    // No Linear-tracked project has ever been configured on this deployment
    // — same 404 as any other unrecognized route, not a 401/500, so an
    // operator probing routes can't distinguish "misconfigured" from "not
    // built here" (matching every existing GitHub-only gateway deployment).
    res.writeHead(404).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['linear-signature'];

  if (!verifyLinearSignature(rawBody, typeof signature === 'string' ? signature : undefined, deps.linearWebhookSecret)) {
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

  const parsed = parseLinearIssueEvent(payload);
  if (!parsed || !isFreshLinearWebhook(parsed.webhookTimestamp, Date.now())) {
    // Not an Issue create/update event this gateway understands, or stale
    // enough to treat as a possible replay — acknowledge, do nothing.
    res.writeHead(204).end();
    return;
  }

  const entry = await resolveManagedProjectEntryByLinearTeamKey(deps.managedProjectDeps, parsed.teamKey);
  if (!entry) {
    console.warn(`gateway: no project registered for Linear team "${parsed.teamKey}" — ignoring issue event`);
    res.writeHead(202).end('no project registered for this Linear team');
    return;
  }

  if (!matchesLinearTriggerLabel(parsed, entry.linearTriggerLabelId)) {
    // Real issue, real project, just not this project's trigger label.
    res.writeHead(204).end();
    return;
  }

  try {
    const scm = deps.buildScm(entry);
    const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
    const result = await startDevCycleForLinearIssue(deps.client, deps.taskQueue, entry.project, parsed, entry.repo, config);
    console.log(
      result.started
        ? `gateway: started devCycle ${result.taskId} for linear:${parsed.identifier}`
        : `gateway: devCycle ${result.taskId} already running for linear:${parsed.identifier} — ignored duplicate label event`,
    );
    res.writeHead(202).end(JSON.stringify(result));
  } catch (err) {
    console.error(`gateway: failed to start devCycle for linear:${parsed.identifier}:`, err);
    res.writeHead(500).end('failed to start task');
  }
}
