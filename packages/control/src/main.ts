import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { loadEnv } from '@agentops/activities';
import { createControlServer } from './create-control-server';
import { readRegistryRepos } from './read-registry-repos';

loadEnv();

async function main(): Promise<void> {
  const temporalUiBaseUrl = process.env.TEMPORAL_UI_BASE_URL;
  if (!temporalUiBaseUrl) {
    throw new Error('TEMPORAL_UI_BASE_URL is required');
  }

  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace });

  const registry = readRegistryRepos();
  console.log(
    registry.length > 0
      ? `agentops control: ${registry.length} repo(s) registered for the hint-repos picker`
      : 'agentops control: no PROJECT_REGISTRY_JSON set — hint-repos picker will offer no suggestions',
  );

  // packages/ui's build output, resolved relative to this file so it works
  // regardless of process.cwd() -- same "runs via tsx src/main.ts, not a
  // compiled dist/" convention as the worker/gateway images. Serving is
  // skipped entirely (404 for non-API GETs) until `pnpm --filter @agentops/ui
  // build` has produced this directory, so local dev without a UI build
  // doesn't crash.
  const uiDistPath = join(__dirname, '../../ui/dist');

  const server = createControlServer({
    client,
    taskQueue: process.env.TASK_QUEUE ?? 'agentops-devcycle',
    namespace,
    temporalUiBaseUrl,
    registry,
    uiDistPath: existsSync(uiDistPath) ? uiDistPath : undefined,
  });

  const port = Number(process.env.PORT ?? 3001);
  server.listen(port, () => {
    console.log(`agentops control listening on :${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
