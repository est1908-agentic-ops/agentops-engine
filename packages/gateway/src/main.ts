import { Client, Connection } from '@temporalio/client';
import { loadEnv, loadProjectRegistry, PostgresManagedProjectStore, SpawnGitCommandRunner, type ManagedProjectRegistryDeps } from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { createGithubPorts } from '@agentops/ports';
import { Pool } from 'pg';
import { createGatewayServer } from './create-gateway-server';

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

  const registry = loadProjectRegistry();
  console.log(
    registry.length > 0
      ? `agentops gateway: ${registry.length} project(s) registered: ${registry.map((e) => `${e.project} (${e.repo})`).join(', ')}`
      : 'agentops gateway: no PROJECT_REGISTRY_JSON set — every webhook will be acknowledged and ignored',
  );

  const managedProjectDeps = buildGatewayManagedProjectDeps();
  if (managedProjectDeps) {
    await managedProjectDeps.store.ensureSchema();
    console.log('agentops gateway: managed-project DB lookup ENABLED (ENGINE_DB_HOST set)');
  }

  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });

  const server = createGatewayServer({
    client,
    taskQueue: TASK_QUEUE,
    webhookSecret,
    triggerLabel: process.env.TRIGGER_LABEL ?? 'agentops',
    registry,
    buildScm,
    managedProjectDeps,
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
