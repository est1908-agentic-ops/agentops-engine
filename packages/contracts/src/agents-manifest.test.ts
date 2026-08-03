import { describe, it, expect } from 'vitest';
import {
  AgentSpecSchema,
  ProjectWorkerSchema,
  validateAgentSpecs,
  BUILTIN_WORKFLOW_INPUTS,
  isBuiltinWorkflow,
  BUILTIN_WORKFLOWS,
  type AgentSpec,
} from './agents-manifest';

const spec = (partial: Partial<AgentSpec> & Pick<AgentSpec, 'name' | 'workflow'>): AgentSpec =>
  AgentSpecSchema.parse({ schedule: '0 2 * * *', ...partial });

describe('AgentSpecSchema', () => {
  it('applies defaults for enabled/timezone/overlap/input', () => {
    const s = AgentSpecSchema.parse({
      name: 'nightly-bughunt',
      workflow: 'whiteboxBugHunt',
      schedule: '0 2 * * *',
    });
    expect(s).toMatchObject({ enabled: true, timezone: 'UTC', overlap: 'skip', input: {} });
  });

  it('rejects unknown entry keys (strict), a bad cron, and a bad name', () => {
    expect(() =>
      AgentSpecSchema.parse({ name: 'x', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', oops: 1 }),
    ).toThrow();
    expect(() =>
      AgentSpecSchema.parse({ name: 'x', workflow: 'whiteboxBugHunt', schedule: 'not cron' }),
    ).toThrow();
    expect(() =>
      AgentSpecSchema.parse({ name: 'Bad_Name', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' }),
    ).toThrow();
  });

  it('accepts "continuous" as a schedule', () => {
    expect(spec({ name: 'mon', workflow: 'whiteboxBugHunt', schedule: 'continuous' }).schedule).toBe(
      'continuous',
    );
  });

  it('accepts an optional taskQueue and leaves it undefined when absent', () => {
    expect(spec({ name: 'r', workflow: 'rollbarMonitor', taskQueue: 'proj-acme' }).taskQueue).toBe(
      'proj-acme',
    );
    expect(spec({ name: 'nb', workflow: 'whiteboxBugHunt' }).taskQueue).toBeUndefined();
  });
});

describe('validateAgentSpecs', () => {
  it('returns null for valid, uniquely-named agents', () => {
    expect(
      validateAgentSpecs([spec({ name: 'a', workflow: 'whiteboxBugHunt', input: { focus: 'auth' } })]),
    ).toBeNull();
  });

  it('rejects duplicate names', () => {
    const err = validateAgentSpecs([
      spec({ name: 'dup', workflow: 'whiteboxBugHunt' }),
      spec({ name: 'dup', workflow: 'whiteboxBugHunt', schedule: '0 3 * * *' }),
    ]);
    expect(err).toMatch(/duplicate/i);
  });

  it('validates per-workflow input against the built-in schema', () => {
    // whiteboxBugHunt input rejects unknown keys
    const err = validateAgentSpecs(
      [spec({ name: 'b', workflow: 'whiteboxBugHunt', input: { nope: 1 } })],
      BUILTIN_WORKFLOW_INPUTS,
    );
    expect(err).toMatch(/input/i);
  });

  it('passes input through for an unknown (Tier-2) workflow', () => {
    expect(
      validateAgentSpecs([spec({ name: 'r', workflow: 'rollbarMonitor', input: { anything: true } })]),
    ).toBeNull();
  });
});

describe('ProjectWorkerSchema', () => {
  it('defaults replicas to 1 and externalSecrets to []', () => {
    expect(ProjectWorkerSchema.parse({ image: 'reg/w:tag' })).toEqual({
      image: 'reg/w:tag',
      replicas: 1,
      externalSecrets: [],
    });
  });
  it('rejects a non-positive replicas, a missing image, and unknown keys (strict)', () => {
    expect(() => ProjectWorkerSchema.parse({ image: 'reg/w:tag', replicas: 0 })).toThrow();
    expect(() => ProjectWorkerSchema.parse({ replicas: 2 })).toThrow();
    expect(() => ProjectWorkerSchema.parse({ image: 'x', nope: 1 })).toThrow();
  });
});

describe('isBuiltinWorkflow', () => {
  it('recognizes the built-in fleet workflows', () => {
    expect(isBuiltinWorkflow('devCycle')).toBe(true);
    expect(isBuiltinWorkflow('whiteboxBugHunt')).toBe(true);
    expect(isBuiltinWorkflow('platform')).toBe(true);
  });
  it('treats any other name as a project (Tier-2) workflow', () => {
    expect(isBuiltinWorkflow('rollbarMonitor')).toBe(false);
    expect(BUILTIN_WORKFLOWS.has('rollbarMonitor')).toBe(false);
  });
});
