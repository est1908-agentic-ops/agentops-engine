import { describe, it, expect } from 'vitest';
import { reconcileAgents, scheduleId } from './reconcile-agents';
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
});
