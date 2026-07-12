import { describe, it, expect } from 'vitest';
import { reconcileAgents, scheduleId, reconcileContinuous } from './reconcile-agents';
import { ENGINE_QUEUE, LEGACY_ENGINE_QUEUE } from '@agentops/contracts';
import type { AgentSpec } from '@agentops/contracts';

const spec = (over: Partial<AgentSpec>): AgentSpec => ({
  name: 'a', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip', ...over,
});

describe('reconcileAgents', () => {
  it('creates when nothing exists', () => {
    const plan = reconcileAgents([spec({ name: 'a' })], []);
    expect(plan.toCreate.map((s) => s.name)).toEqual(['a']);
  });
  it('deletes orphans not in the manifest', () => {
    const plan = reconcileAgents([], [{ id: scheduleId('p', 'gone'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }]);
    expect(plan.toDelete).toEqual([scheduleId('p', 'gone')]);
  });
  it('updates when the cron changed', () => {
    const existing = [{ id: scheduleId('p', 'a'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }];
    const plan = reconcileAgents([spec({ name: 'a', schedule: '0 5 * * *' })], existing, 'p');
    expect(plan.toUpdate.map((s) => s.name)).toEqual(['a']);
  });
  it('updates when the workflow name changed', () => {
    const existing = [{ id: scheduleId('p', 'a'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }];
    const plan = reconcileAgents([spec({ name: 'a', workflow: 'otherWF' })], existing, 'p');
    expect(plan.toUpdate.map((s) => s.name)).toEqual(['a']);
  });
  it('pauses a disabled agent and resumes a re-enabled one', () => {
    const idA = scheduleId('p', 'a');
    expect(reconcileAgents([spec({ name: 'a', enabled: false })], [{ id: idA, scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }], 'p').toPause).toEqual([idA]);
    expect(reconcileAgents([spec({ name: 'a', enabled: true })], [{ id: idA, scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: true }], 'p').toResume).toEqual([idA]);
  });

  it('re-points a schedule still on the legacy queue', () => {
    const declared = [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
    const existing = [{ id: scheduleId('p', 'nb'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false, taskQueue: LEGACY_ENGINE_QUEUE }];
    const plan = reconcileAgents(declared as any, existing, 'p'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(plan.toUpdate.map((s) => s.name)).toContain('nb');
  });

  it('does not update a schedule already on the engine queue', () => {
    const declared = [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
    const existing = [{ id: scheduleId('p', 'nb'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false, taskQueue: ENGINE_QUEUE }];
    const plan = reconcileAgents(declared as any, existing, 'p'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(plan.toUpdate).toHaveLength(0);
  });

  it('re-points a scheduled Tier-2 agent to its own taskQueue', () => {
    const declared = [{ name: 'nightly', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const, taskQueue: 'proj-acme' }];
    const existing = [{ id: scheduleId('acme', 'nightly'), scheduleSpec: '0 2 * * *', workflow: 'projectScan', paused: false, taskQueue: ENGINE_QUEUE }];
    const plan = reconcileAgents(declared as any, existing, 'acme'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(plan.toUpdate.map((s) => s.name)).toContain('nightly');
  });

  it('leaves a built-in scheduled agent on ENGINE_QUEUE (no taskQueue set)', () => {
    const declared = [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
    const existing = [{ id: scheduleId('acme', 'nb'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false, taskQueue: ENGINE_QUEUE }];
    expect(reconcileAgents(declared as any, existing, 'acme').toUpdate).toHaveLength(0); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

const cont = (name: string) => ({ name, workflow: 'rollbarMonitor', schedule: 'continuous' as const, input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const, taskQueue: 'proj-acme' });

it('starts declared continuous agents that are not running', () => {
  const plan = reconcileContinuous([cont('mon')], [], 'acme');
  expect(plan.toStart.map((s) => s.name)).toEqual(['mon']);
  expect(plan.toTerminate).toEqual([]);
});
it('terminates running singletons no longer declared', () => {
  const plan = reconcileContinuous([], [scheduleId('acme', 'mon')], 'acme');
  expect(plan.toStart).toEqual([]);
  expect(plan.toTerminate).toEqual([scheduleId('acme', 'mon')]);
});
it('is idempotent for an already-running declared agent', () => {
  const plan = reconcileContinuous([cont('mon')], [scheduleId('acme', 'mon')], 'acme');
  expect(plan.toStart).toEqual([]);
  expect(plan.toTerminate).toEqual([]);
});
it('excludes a disabled continuous agent (treated as terminate)', () => {
  const plan = reconcileContinuous([{ ...cont('mon'), enabled: false }], [scheduleId('acme', 'mon')], 'acme');
  expect(plan.toTerminate).toEqual([scheduleId('acme', 'mon')]);
});

