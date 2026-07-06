import { Client, Connection } from '@temporalio/client';
import { loadEnv, loadProjectRegistry, SpawnGitCommandRunner } from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { createGithubPorts } from '@agentops/ports';
import { createGatewayServer } from './create-gateway-server';

loadEnv();

const TASK_QUEUE = 'agentops-devcycle';

function buildScm(entry: ResolvedProjectEntry) {
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

async function main(): Promise<void> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }

  const registry = loadProjectRegistry();
  console.log(
    registry.length > 0
      ? `agentops gateway: ${registry.length} project(s) registered: ${registry.map((e) => `${e.product} (${e.repo})`).join(', ')}`
      : 'agentops gateway: no PROJECT_REGISTRY_JSON set — every webhook will be acknowledged and ignored',
  );

  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });

  const server = createGatewayServer({
    client,
    taskQueue: TASK_QUEUE,
    webhookSecret,
    triggerLabel: process.env.TRIGGER_LABEL ?? 'agentops',
    registry,
    buildScm,
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
