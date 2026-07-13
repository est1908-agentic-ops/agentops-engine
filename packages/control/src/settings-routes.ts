import {
  SelfHealSettingsResponseSchema,
  UpdateSelfHealSettingsRequestSchema,
  ENGINE_QUEUE,
} from '@agentops/contracts';
import {
  ensureSelfHealSchedule,
  selfHealDefaultsFromEnv,
  type SelfHealScheduleClient,
  type PostgresEngineSettingsStore,
} from '@agentops/activities';
import type { Client } from '@temporalio/client';
import type { IncomingMessage } from 'node:http';
import { readJsonBody, type HandlerResponse } from './handler-util';

const SELF_HEAL_SCHEDULE_ID = 'self-heal';

export interface SettingsRouteDeps {
  client: Client;
  engineSettingsStore?: PostgresEngineSettingsStore;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function isSelfHealScheduleActive(client: Client): Promise<boolean> {
  try {
    const handle = (client.schedule as any).getHandle(SELF_HEAL_SCHEDULE_ID);
    const describe = handle.describe?.bind(handle);
    if (!describe) return false;
    await describe();
    return true;
  } catch {
    return false;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function loadSelfHealSettings(deps: SettingsRouteDeps) {
  if (deps.engineSettingsStore) {
    await deps.engineSettingsStore.ensureSchema();
    await deps.engineSettingsStore.seedIfEmpty(selfHealDefaultsFromEnv());
    return deps.engineSettingsStore.getSelfHeal();
  }
  return selfHealDefaultsFromEnv();
}

export async function handleGetSelfHealSettings(deps: SettingsRouteDeps): Promise<HandlerResponse> {
  const settings = await loadSelfHealSettings(deps);
  const scheduleActive = await isSelfHealScheduleActive(deps.client);
  return {
    status: 200,
    body: SelfHealSettingsResponseSchema.parse({ ...settings, scheduleActive }),
  };
}

export async function handleUpdateSelfHealSettings(
  deps: SettingsRouteDeps,
  req: IncomingMessage,
): Promise<HandlerResponse> {
  if (!deps.engineSettingsStore) {
    return { status: 503, body: { error: 'settings store unavailable (requires ENGINE_DB_HOST)' } };
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = UpdateSelfHealSettingsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }
  await deps.engineSettingsStore.ensureSchema();
  await deps.engineSettingsStore.seedIfEmpty(selfHealDefaultsFromEnv());
  const settings = await deps.engineSettingsStore.setSelfHeal({ enabled: parsed.data.enabled });
  try {
    await ensureSelfHealSchedule(
      deps.client.schedule as unknown as SelfHealScheduleClient,
      ENGINE_QUEUE,
      settings,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: `failed to apply self-heal schedule: ${msg}` } };
  }
  const scheduleActive = await isSelfHealScheduleActive(deps.client);
  return {
    status: 200,
    body: SelfHealSettingsResponseSchema.parse({ ...settings, scheduleActive }),
  };
}