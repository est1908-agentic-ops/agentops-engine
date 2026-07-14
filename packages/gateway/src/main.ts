import { Client, Connection } from '@temporalio/client';
import { loadEnv, PostgresManagedProjectStore, SpawnGitCommandRunner, type ManagedProjectRegistryDeps } from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { DEFAULT_TRIGGER_LABEL } from '@agentops/contracts';
import { createGithubPorts } from '@agentops/ports';
import { Pool } from 'pg';
import { createGatewayServer } from './create-gateway-server';
import { createProjectWorkerParamsProvider } from './argocd-project-workers';

loadEnv();

const TASK_QUEUE = 'agentops-devcycle';

function buildScm(entry: ResolvedProjectEntry) {
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

function buildGatewayManagedProjectDeps(): ManagedProjectRegistryDeps | undefined {
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

async function main(): Promise<void> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }

  const managedProjectDeps = buildGatewayManagedProjectDeps();
  if (managedProjectDeps) {
    await managedProjectDeps.store.ensureSchema();
    console.log('agentops gateway: managed-project DB lookup ENABLED (ENGINE_DB_HOST set)');
  } else {
    console.warn(
      'agentops gateway: no managed-project DB configured (ENGINE_DB_HOST/PROJECT_CREDENTIAL_PRIVATE_KEY unset) — every webhook will be acknowledged and ignored, nothing is registered anywhere',
    );
  }

  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });

  const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  console.log(
    linearWebhookSecret
      ? 'agentops gateway: Linear webhook route ENABLED (LINEAR_WEBHOOK_SECRET set)'
      : 'agentops gateway: Linear webhook route disabled (LINEAR_WEBHOOK_SECRET unset)',
  );

  // ArgoCD ApplicationSet plugin generator: serves per-project worker specs read
  // from each project's agents.json (spec §5.2/§6, Option A — hosted here, not on
  // the encrypt-only control). Off unless ARGOCD_PLUGIN_TOKEN is set.
  const argocdPluginToken = process.env.ARGOCD_PLUGIN_TOKEN;
  const argocdParams = createProjectWorkerParamsProvider({ managedProjectDeps, buildScm });
  console.log(
    argocdPluginToken
      ? 'agentops gateway: ArgoCD project-workers generator ENABLED (ARGOCD_PLUGIN_TOKEN set)'
      : 'agentops gateway: ArgoCD project-workers generator disabled (ARGOCD_PLUGIN_TOKEN unset)',
  );

  const server = createGatewayServer({
    client,
    taskQueue: TASK_QUEUE,
    webhookSecret,
    triggerLabel: process.env.TRIGGER_LABEL ?? DEFAULT_TRIGGER_LABEL,
    buildScm,
    managedProjectDeps,
    linearWebhookSecret,
    argocdParams,
    argocdPluginToken,
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`agentops gateway listening on :${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
