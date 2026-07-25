import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import {
  FileManagedProjectStore,
  loadEnv,
  PostgresEngineSettingsStore,
  PostgresStatsStore,
  PostgresTierStore,
} from '@agentops/activities';
import { Pool } from 'pg';
import { createControlServer } from './create-control-server';

loadEnv();

// Read-only project registry, backed by the mounted managed-projects
// ConfigMap dir -- same construction worker/gateway/cli use. Unlike them,
// control never resolves a token (no KubeTokenResolver here): it only reads
// project/repo/config metadata for the console's list/detail views, so it
// needs no secrets:get RBAC.
function buildManagedProjectStore(): FileManagedProjectStore {
  const dir = process.env.MANAGED_PROJECTS_DIR ?? '/etc/managed-projects';
  return new FileManagedProjectStore(dir);
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

function buildStatsStore(): PostgresStatsStore | undefined {
  const host = process.env.ENGINE_DB_HOST;
  if (!host) {
    return undefined;
  }
  return new PostgresStatsStore(
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
  const statsStore = buildStatsStore();
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
  if (statsStore) {
    await statsStore.ensureSchema();
    console.log('agentops control: /api/budgets ENABLED (ENGINE_DB_HOST set)');
  } else {
    console.log('agentops control: /api/budgets disabled (no ENGINE_DB_HOST)');
  }
  // Read-only: /api/projects and /api/registry/repos always work (no gating,
  // no schema to ensure) -- they read a mounted ConfigMap dir, not a DB.
  console.log('agentops control: /api/projects (read-only) serving from ' + (process.env.MANAGED_PROJECTS_DIR ?? '/etc/managed-projects'));
  const projectCrudAuthToken = process.env.CONTROL_CRUD_TOKEN;
  if (projectCrudAuthToken) {
    console.log(
      'agentops control: mutating routes (platform/devcycle run-starts, chats, tiers PUT, self-heal PUT, agent triggers) are token-protected (CONTROL_CRUD_TOKEN set)',
    );
  } else {
    console.warn(
      'agentops control: CONTROL_CRUD_TOKEN is not set -- all mutating routes (platform/devcycle run-starts, chats, tiers PUT, self-heal PUT, agent triggers) fail-closed with 401',
    );
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
    statsStore,
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
