import { describe, it, expect } from 'vitest';
import { parseAgentsManifest, BUILTIN_WORKFLOW_INPUTS, InvalidAgentsManifestError } from './agents-manifest';

const opts = { workflowInputs: BUILTIN_WORKFLOW_INPUTS };

describe('parseAgentsManifest', () => {
  it('accepts a valid whiteboxBugHunt entry', () => {
    const m = parseAgentsManifest(
      { agents: [{ name: 'nightly-bughunt', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: { focus: 'auth' } }] },
      opts,
    );
    expect(m.agents[0]).toMatchObject({ name: 'nightly-bughunt', enabled: true, timezone: 'UTC', overlap: 'skip' });
  });

  it('rejects unknown top-level/entry keys (strict)', () => {
    expect(() => parseAgentsManifest({ agents: [], oops: 1 }, opts)).toThrow(InvalidAgentsManifestError);
  });

  it('rejects a bad cron and a bad name', () => {
    expect(() => parseAgentsManifest({ agents: [{ name: 'x', workflow: 'whiteboxBugHunt', schedule: 'not cron' }] }, opts)).toThrow(InvalidAgentsManifestError);
    expect(() => parseAgentsManifest({ agents: [{ name: 'Bad_Name', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' }] }, opts)).toThrow(InvalidAgentsManifestError);
  });

  it('accepts "continuous" as a schedule', () => {
    const m = parseAgentsManifest({ agents: [{ name: 'mon', workflow: 'whiteboxBugHunt', schedule: 'continuous' }] }, opts);
    expect(m.agents[0].schedule).toBe('continuous');
  });

  it('validates per-workflow input against the workflow schema', () => {
    // whiteboxBugHunt input rejects unknown keys
    expect(() => parseAgentsManifest({ agents: [{ name: 'b', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: { nope: 1 } }] }, opts)).toThrow(InvalidAgentsManifestError);
  });

  it('passes input through for an unknown (Tier-2) workflow', () => {
    const m = parseAgentsManifest({ agents: [{ name: 'r', workflow: 'rollbarMonitor', schedule: 'continuous', input: { anything: true } }] }, opts);
    expect(m.agents[0].input).toEqual({ anything: true });
  });

  it('rejects duplicate names', () => {
    expect(() => parseAgentsManifest({ agents: [
      { name: 'dup', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' },
      { name: 'dup', workflow: 'whiteboxBugHunt', schedule: '0 3 * * *' },
    ] }, opts)).toThrow(/duplicate/i);
  });

  it('accepts an optional taskQueue and defaults it absent', () => {
    const m = parseAgentsManifest({ agents: [{ name: 'r', workflow: 'rollbarMonitor', schedule: 'continuous', taskQueue: 'proj-acme' }] }, opts);
    expect(m.agents[0].taskQueue).toBe('proj-acme');
    const m2 = parseAgentsManifest({ agents: [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' }] }, opts);
    expect(m2.agents[0].taskQueue).toBeUndefined();
  });
});
