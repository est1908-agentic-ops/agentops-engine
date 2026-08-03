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
import { parseIssueTriggerEvent } from './parse-issue-labeled';
import { parsePushEvent } from './parse-push-event';
import { parsePrLandingEvent } from './parse-pr-landing-event';
import { parsePrReviewEvent } from './parse-pr-review-event';
import { startConfigSync } from './start-config-sync';
import { startDevCycleForIssue } from './start-dev-cycle';
import { startOrSignalPrLanding } from './start-pr-landing';
import { verifyGithubSignature } from './verify-signature';
import {
  parseLinearIssueEvent,
  matchesLinearTriggerLabel,
} from './parse-linear-issue-event';
import { verifyLinearSignature, isFreshLinearWebhook } from './verify-linear-signature';
import { startDevCycleForLinearIssue } from './start-dev-cycle-for-linear-issue';

export interface GatewayDeps {
  client: Client;
  taskQueue: string;
  webhookSecret: string;
  linearWebhookSecret?: string;
  triggerLabel: string;
  // Injectable so tests don't need a live GitHub client — the real caller
  // (main.ts) builds a GithubScmPort from the entry's token.
  buildScm: (entry: ResolvedProjectEntry) => ScmPort;
  // The only project registry -- ConfigMap-dir-backed (FileManagedProjectStore),
  // per-project tokens resolved via the K8s API by Secret name. Undefined means
  // every webhook is acknowledged and ignored (nothing is registered anywhere)
  // -- only used by tests exercising that fallback; the real gateway (main.ts)
  // always builds one.
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

async function handleRequest(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/webhooks/github') {
    await handleGithubWebhook(deps, req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/webhooks/linear' && deps.linearWebhookSecret) {
    await handleLinearWebhook(deps, req, res);
    return;
  }

  res.writeHead(404).end();
}

async function handleGithubWebhook(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readRawBody(req);
  const signature = req.headers['x-hub-signature-256'];

  if (
    !verifyGithubSignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      deps.webhookSecret,
    )
  ) {
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
      console.log(
        `gateway: push → configSync for project "${entry.project}" (started=${result.started})`,
      );
      res.writeHead(result.started ? 202 : 204).end();
    } catch (err) {
      console.error('gateway: failed to start configSync from push webhook', err);
      res.writeHead(500).end('failed to start configSync');
    }
    return;
  }

  const landingEvent = parsePrLandingEvent(eventType, payload);
  if (landingEvent) {
    const entry = await resolveManagedProjectEntry(deps.managedProjectDeps, landingEvent.repo);
    if (!entry) {
      res.writeHead(202).end('no project registered');
      return;
    }
    const scm = deps.buildScm(entry);
    const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
    if (
      !landingEvent.managed &&
      landingEvent.kind === 'enroll' &&
      (config.autoMerge ?? 'disabled') === 'disabled'
    ) {
      res.writeHead(204).end();
      return;
    }
    try {
      const result = await startOrSignalPrLanding(
        deps.client,
        deps.taskQueue,
        entry.project,
        landingEvent,
        config,
      );
      console.log(
        `gateway: ${result.started ? 'started' : 'signalled'} prLanding ${result.workflowId} for ${landingEvent.prRef}`,
      );
      res.writeHead(result.started ? 202 : 204).end(JSON.stringify(result));
    } catch (err) {
      console.error('gateway: failed to start or signal pr landing', err);
      res.writeHead(500).end('failed to start landing');
    }
    return;
  }

  const reviewEvent = parsePrReviewEvent(eventType, payload);
  if (reviewEvent) {
    res.writeHead(204).end();
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
    console.warn(
      `gateway: no project registered for repo "${event.repo}" — ignoring labeled event`,
    );
    res.writeHead(202).end('no project registered for this repo');
    return;
  }

  try {
    const scm = deps.buildScm(entry);
    const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
    const result = await startDevCycleForIssue(
      deps.client,
      deps.taskQueue,
      entry.project,
      event,
      config,
    );
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

async function handleLinearWebhook(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readRawBody(req);
  const signature = req.headers['linear-signature'];

  if (
    !verifyLinearSignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      deps.linearWebhookSecret!,
    )
  ) {
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

  const event = parseLinearIssueEvent(payload);
  if (!event) {
    // Not an Issue create/update event — acknowledge, do nothing.
    res.writeHead(204).end();
    return;
  }

  if (!isFreshLinearWebhook(event.webhookTimestamp, Date.now())) {
    console.warn(
      `gateway: Linear webhook stale for issue "${event.identifier}" — ignoring`,
    );
    res.writeHead(202).end('webhook too old');
    return;
  }

  const entry = await resolveManagedProjectEntryByLinearTeamKey(
    deps.managedProjectDeps,
    event.teamKey,
  );
  if (!entry || entry.trackerType !== 'linear') {
    console.warn(
      `gateway: no project registered for Linear team "${event.teamKey}" — ignoring issue event`,
    );
    res.writeHead(202).end('no project registered for this team');
    return;
  }

  if (!matchesLinearTriggerLabel(event, entry.linearTriggerLabelId)) {
    // Label present but not a fresh trigger-label add — do nothing.
    res.writeHead(204).end();
    return;
  }

  try {
    const scm = deps.buildScm(entry);
    const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
    const result = await startDevCycleForLinearIssue(
      deps.client,
      deps.taskQueue,
      entry.project,
      event,
      entry.repo,
      config,
    );
    console.log(
      result.started
        ? `gateway: started devCycle ${result.taskId} for ${event.identifier}`
        : `gateway: devCycle ${result.taskId} already running for ${event.identifier} — ignored duplicate label event`,
    );
    res.writeHead(202).end(JSON.stringify(result));
  } catch (err) {
    console.error(`gateway: failed to start devCycle for ${event.identifier}:`, err);
    res.writeHead(500).end('failed to start task');
  }
}
