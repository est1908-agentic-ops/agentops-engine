import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { loadEnv, PostgresEngineSettingsStore, PostgresManagedProjectStore, PostgresTierStore } from '@agentops/activities';
import { Pool } from 'pg';
import { createControlServer } from './create-control-server';

loadEnv();

function buildManagedProjectStore(): PostgresManagedProjectStore | undefined {
  const host = process.env.ENGINE_DB_HOST;
  const publicKey = process.env.PROJECT_CREDENTIAL_PUBLIC_KEY;
  if (!host || !publicKey) {
    return undefined;
  }
  return new PostgresManagedProjectStore(
    new Pool({
      host,
      port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
      database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
      user: process.env.ENGINE_DB_USER ?? 'temporal',
      password: process.env.ENGINE_DB_PASSWORD,
    }),
  );
}

// Tiers table (SP3-B). Only needs ENGINE_DB_HOST (no credential key).
function buildTierStore(): PostgresTierStore | undefined {
  const host = process.env.ENGINE_DB_HOST;
  if (!host) {
    return undefined;
  }
  return new PostgresTierStore(
    new Pool({
      host,
      port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
      database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
      user: process.env.ENGINE_DB_USER ?? 'temporal',
      password: process.env.ENGINE_DB_PASSWORD,
    }),
  );
}

function buildEngineSettingsStore(): PostgresEngineSettingsStore | undefined {
  const host = process.env.ENGINE_DB_HOST;
  if (!host) {
    return undefined;
  }
  return new PostgresEngineSettingsStore(
    new Pool({
      host,
      port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
      database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
      user: process.env.ENGINE_DB_USER ?? 'temporal',
      password: process.env.ENGINE_DB_PASSWORD,
    }),
  );
}

async function main(): Promise<void> {
  const temporalUiBaseUrl = process.env.TEMPORAL_UI_BASE_URL;
  if (!temporalUiBaseUrl) {
    throw new Error('TEMPORAL_UI_BASE_URL is required');
  }

  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace });

  const managedProjectStore = buildManagedProjectStore();
  const tierStore = buildTierStore();
  const engineSettingsStore = buildEngineSettingsStore();
  if (tierStore) {
    await tierStore.ensureSchema();
    console.log('agentops control: /api/tiers ENABLED (ENGINE_DB_HOST set)');
  } else {
    console.log('agentops control: /api/tiers disabled (no ENGINE_DB_HOST)');
  }
  if (engineSettingsStore) {
    await engineSettingsStore.ensureSchema();
    console.log('agentops control: /api/settings/self-heal ENABLED (ENGINE_DB_HOST set)');
  } else {
    console.log('agentops control: /api/settings/self-heal disabled (requires ENGINE_DB_HOST)');
  }
  const projectCrudAuthToken = process.env.CONTROL_CRUD_TOKEN;
  if (managedProjectStore) {
    await managedProjectStore.ensureSchema();
    if (projectCrudAuthToken) {
      console.log('agentops control: managed-project CRUD routes ENABLED and token-protected (CONTROL_CRUD_TOKEN set)');
    } else {
      console.warn(
        'agentops control: managed-project store is configured but CRUD routes are DISABLED — set CONTROL_CRUD_TOKEN to enable /api/projects',
      );
    }
  } else if (projectCrudAuthToken) {
    console.warn(
      'agentops control: CONTROL_CRUD_TOKEN is set but managed-project store is unavailable (need ENGINE_DB_HOST + PROJECT_CREDENTIAL_PUBLIC_KEY) — /api/projects disabled',
    );
  } else {
    console.log('agentops control: managed-project CRUD routes disabled (no ENGINE_DB_* / PROJECT_CREDENTIAL_PUBLIC_KEY / CONTROL_CRUD_TOKEN)');
  }

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
    uiDistPath: existsSync(uiDistPath) ? uiDistPath : undefined,
    managedProjectStore,
    tierStore,
    engineSettingsStore,
    projectCredentialPublicKey: process.env.PROJECT_CREDENTIAL_PUBLIC_KEY,
    projectCrudAuthToken,
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
