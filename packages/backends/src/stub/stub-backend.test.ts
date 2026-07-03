import { describe, expect, it } from 'vitest';
import { StubBackend } from './stub-backend';

const baseRequest = {
  taskId: 'task-1',
  backend: 'stub',
  model: 'stub-v1',
  prompt: 'rendered prompt text',
  workspaceRef: 'demo/repo',
  limits: { maxTokens: 1000, timeoutMs: 60_000 },
} as const;

describe('StubBackend', () => {
  it('returns the response scripted for (stage, attempt, callIndex)', async () => {
    const stub = new StubBackend();
    stub.scriptResponse('implement', 1, { output: 'diff --git a/f b/f' });
    const result = await stub.run({ ...baseRequest, stage: 'implement', attempt: 1, callIndex: 1 });
    expect(result.output).toBe('diff --git a/f b/f');
  });

  it('distinguishes repeated calls within the same (stage, attempt) via callIndex', async () => {
    const stub = new StubBackend();
    stub.scriptResponse('review', 1, { output: 'garbage' }, 1);
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' }, 2);
    const call1 = await stub.run({ ...baseRequest, stage: 'review', attempt: 1, callIndex: 1 });
    const call2 = await stub.run({ ...baseRequest, stage: 'review', attempt: 1, callIndex: 2 });
    expect(call1.output).toBe('garbage');
    expect(call2.output).toBe('VERDICT: PASS');
  });

  it('falls back to a deterministic default response when nothing is scripted', async () => {
    const stub = new StubBackend();
    const result = await stub.run({ ...baseRequest, stage: 'context', attempt: 1, callIndex: 1 });
    expect(result).toEqual({ output: '', tokensIn: 10, tokensOut: 10, wallMs: 100 });
  });

  it('lets a scripted response override only some fields, defaulting the rest', async () => {
    const stub = new StubBackend();
    stub.scriptResponse('full_verify', 1, { output: 'FULL: FAIL', tokensIn: 5000 });
    const result = await stub.run({ ...baseRequest, stage: 'full_verify', attempt: 1, callIndex: 1 });
    expect(result).toEqual({ output: 'FULL: FAIL', tokensIn: 5000, tokensOut: 10, wallMs: 100 });
  });
});
