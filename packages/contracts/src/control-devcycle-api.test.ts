import { describe, expect, it } from 'vitest';
import {
  DevCycleRunDetailSchema,
  DevCycleTargetsResponseSchema,
  StartDevCycleRequestSchema,
  StartDevCycleResponseSchema,
} from './control-devcycle-api';

describe('StartDevCycleRequestSchema', () => {
  it('accepts repo + prompt, taskId optional', () => {
    expect(StartDevCycleRequestSchema.parse({ repo: 'acme/app', prompt: 'add a widget' })).toEqual({
      repo: 'acme/app',
      prompt: 'add a widget',
    });
    expect(
      StartDevCycleRequestSchema.parse({ repo: 'acme/app', prompt: 'x', taskId: 't-1' }).taskId,
    ).toBe('t-1');
  });

  it('rejects an empty prompt and a missing repo', () => {
    expect(StartDevCycleRequestSchema.safeParse({ repo: 'acme/app', prompt: '' }).success).toBe(
      false,
    );
    expect(StartDevCycleRequestSchema.safeParse({ prompt: 'x' }).success).toBe(false);
  });
});

describe('StartDevCycleResponseSchema', () => {
  it('requires workflowId, runId, and taskId', () => {
    expect(
      StartDevCycleResponseSchema.parse({ workflowId: 'prompt-demo-t1', runId: 'r1', taskId: 't1' })
        .taskId,
    ).toBe('t1');
    expect(StartDevCycleResponseSchema.safeParse({ workflowId: 'w', runId: 'r' }).success).toBe(
      false,
    );
  });
});

describe('DevCycleRunDetailSchema', () => {
  const BASE = {
    workflowId: 'prompt-demo-t1',
    runId: 'r1',
    status: 'RUNNING',
    temporalUrl: 'https://temporal.example/namespaces/default/workflows/prompt-demo-t1/r1/history',
  };

  it('accepts a bare running detail (no state yet)', () => {
    expect(DevCycleRunDetailSchema.parse(BASE).state).toBeUndefined();
  });

  it('accepts an embedded DevCycleState', () => {
    const detail = DevCycleRunDetailSchema.parse({
      ...BASE,
      status: 'COMPLETED',
      prompt: 'add a widget',
      state: {
        taskId: 't1',
        stage: 'done',
        status: 'done',
        blockReason: null,
        implementAttempts: 1,
        iterations: 1,
        cumulativeTokens: 42,
        babysitRounds: 1,
        prRef: 'pr-1',
        workspaceRef: 'ws-1',
        branch: 'task/t1',
        landingOutcome: null,
      },
    });
    expect(detail.state?.prRef).toBe('pr-1');
  });

  it('rejects an unknown run status', () => {
    expect(DevCycleRunDetailSchema.safeParse({ ...BASE, status: 'BANANAS' }).success).toBe(false);
  });
});

describe('DevCycleTargetsResponseSchema', () => {
  it('accepts a list of repo/project pairs', () => {
    const parsed = DevCycleTargetsResponseSchema.parse({
      targets: [{ repo: 'acme/app', project: 'app' }],
    });
    expect(parsed.targets).toHaveLength(1);
  });

  it('rejects a target missing its project slug', () => {
    expect(
      DevCycleTargetsResponseSchema.safeParse({ targets: [{ repo: 'acme/app' }] }).success,
    ).toBe(false);
  });
});
