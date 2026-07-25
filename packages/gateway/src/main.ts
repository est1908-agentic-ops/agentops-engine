import { Client, Connection } from '@temporalio/client';
import {
  FileManagedProjectStore,
  KubeTokenResolver,
  loadEnv,
  SpawnGitCommandRunner,
  type ManagedProjectRegistryDeps,
} from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { DEFAULT_TRIGGER_LABEL } from '@agentops/contracts';
import { createGithubPorts } from '@agentops/ports';
import { createGatewayServer } from './create-gateway-server';

loadEnv();

const TASK_QUEUE = 'agentops-devcycle';

function buildScm(entry: ResolvedProjectEntry) {
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

// Per-project tokens, read from a mounted managed-projects ConfigMap dir and
// resolved via the K8s API by Secret name -- not a single shared GITHUB_TOKEN
// env var (that design was superseded) and no longer coupled to a Postgres
// pool (the DB-backed registry is retired for the gateway).
function buildGatewayManagedProjectDeps(): ManagedProjectRegistryDeps {
  const dir = process.env.MANAGED_PROJECTS_DIR ?? '/etc/managed-projects';
  const namespace = process.env.AGENT_NAMESPACE ?? 'dev-agents';
  const store = new FileManagedProjectStore(dir);
  const resolver = new KubeTokenResolver(namespace);
  return { store, resolveToken: (tokenSecret) => resolver.get(tokenSecret) };
}

async function main(): Promise<void> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }

  const managedProjectDeps = buildGatewayManagedProjectDeps();
  console.log('agentops gateway: managed projects loaded from the mounted ConfigMap');

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });

  const server = createGatewayServer({
    client,
    taskQueue: TASK_QUEUE,
    webhookSecret,
    triggerLabel: process.env.TRIGGER_LABEL ?? DEFAULT_TRIGGER_LABEL,
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
