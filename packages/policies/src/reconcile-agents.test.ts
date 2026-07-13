import { describe, it, expect } from 'vitest';
import { reconcileAgents, scheduleId, reconcileContinuous, resolveAgentQueue, projectQueue, workerWarnings, orphanScheduleIds } from './reconcile-agents';
import { ENGINE_QUEUE, LEGACY_ENGINE_QUEUE } from '@agentops/contracts';
import type { AgentSpec, AgentsManifest } from '@agentops/contracts';

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

  it('re-points a project workflow with no explicit taskQueue from ENGINE_QUEUE to proj-<project>', () => {
    // The SP-b default: a custom (non-built-in) workflow now defaults to its
    // project queue even without an explicit taskQueue.
    const declared = [{ name: 'scan', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
    const existing = [{ id: scheduleId('acme', 'scan'), scheduleSpec: '0 2 * * *', workflow: 'projectScan', paused: false, taskQueue: ENGINE_QUEUE }];
    expect(reconcileAgents(declared as any, existing, 'acme').toUpdate.map((s) => s.name)).toContain('scan'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

describe('resolveAgentQueue', () => {
  it('honors an explicit taskQueue above all', () => {
    expect(resolveAgentQueue({ workflow: 'whiteboxBugHunt', taskQueue: 'custom' }, 'acme')).toBe('custom');
    expect(resolveAgentQueue({ workflow: 'rollbarMonitor', taskQueue: 'custom' }, 'acme')).toBe('custom');
  });
  it('routes a built-in workflow to the engine queue', () => {
    expect(resolveAgentQueue({ workflow: 'whiteboxBugHunt', taskQueue: undefined }, 'acme')).toBe(ENGINE_QUEUE);
    expect(resolveAgentQueue({ workflow: 'devCycle', taskQueue: undefined }, 'acme', LEGACY_ENGINE_QUEUE)).toBe(LEGACY_ENGINE_QUEUE);
  });
  it('routes a project (Tier-2) workflow to proj-<project>', () => {
    expect(resolveAgentQueue({ workflow: 'rollbarMonitor', taskQueue: undefined }, 'acme')).toBe('proj-acme');
    expect(projectQueue('broccoli')).toBe('proj-broccoli');
  });
});

describe('workerWarnings', () => {
  const manifest = (over: Partial<AgentsManifest>): AgentsManifest =>
    ({ agents: [], ...over }) as AgentsManifest;
  it('warns when a custom workflow is scheduled but no worker block is declared', () => {
    const m = manifest({ agents: [{ name: 'scan', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' }] });
    const w = workerWarnings(m, 'acme');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/projectScan.*proj-acme.*no "worker"/);
  });
  it('is silent when a worker block is present', () => {
    const m = manifest({
      agents: [{ name: 'scan', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' }],
      worker: { image: 'reg/w:tag', replicas: 1, externalSecrets: [] },
    });
    expect(workerWarnings(m, 'acme')).toEqual([]);
  });
  it('is silent for built-in workflows even without a worker block', () => {
    const m = manifest({ agents: [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' }] });
    expect(workerWarnings(m, 'acme')).toEqual([]);
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


describe('orphanScheduleIds', () => {
  it('flags agent schedules whose project is no longer managed', () => {
    const ids = [
      scheduleId('broccoli', 'smoke-test'),
      scheduleId('broccoli', 'nightly-bughunt'),
      scheduleId('acme', 'nightly'),
    ];
    expect(orphanScheduleIds(ids, ['acme'])).toEqual([
      scheduleId('broccoli', 'smoke-test'),
      scheduleId('broccoli', 'nightly-bughunt'),
    ]);
  });

  it('keeps schedules for live projects and never touches non-agent schedules', () => {
    const ids = [scheduleId('acme', 'nightly'), 'reconcile:all', 'self-heal'];
    expect(orphanScheduleIds(ids, ['acme'])).toEqual([]);
  });

  it('matches by project prefix, so a project name is not confused with a longer one', () => {
    const ids = [scheduleId('acme', 'a'), scheduleId('acme-staging', 'a')];
    // only 'acme' is live -> 'acme-staging' is an orphan (prefix is `agent:acme:`, not `agent:acme`)
    expect(orphanScheduleIds(ids, ['acme'])).toEqual([scheduleId('acme-staging', 'a')]);
  });

  it('handles project/agent names containing spaces or colons via prefix match', () => {
    const live = 'Artem private agents';
    const ids = [scheduleId(live, 'smoke'), scheduleId('gone', 'x')];
    expect(orphanScheduleIds(ids, [live])).toEqual([scheduleId('gone', 'x')]);
  });

  it('returns everything when no projects are live', () => {
    const ids = [scheduleId('acme', 'a'), scheduleId('broccoli', 'b')];
    expect(orphanScheduleIds(ids, [])).toEqual(ids);
  });
});
