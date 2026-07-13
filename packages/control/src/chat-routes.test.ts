import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { ControlDeps } from './create-control-server';
import {
  handleDecision,
  handleGetChat,
  handleSendTurn,
  handleStartChat,
} from './chat-routes';

function jsonReq(body: unknown): any {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield* chunks;
    },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      if (event === 'end') cb();
      return this;
    },
  };
}

function depsWith(client: Partial<Client['workflow']>): ControlDeps {
  return {
    client: { workflow: client } as unknown as Client,
    taskQueue: 'q',
    namespace: 'default',
    temporalUiBaseUrl: 'http://temporal.local',
  };
}

describe('chat-routes', () => {
  it('starts a platformChat and returns chatId/runId', async () => {
    const start = vi.fn().mockResolvedValue({ workflowId: 'platform-chat-1', firstExecutionRunId: 'run-1' });
    const res = await handleStartChat(depsWith({ start } as never), jsonReq({ prompt: 'hi' }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ chatId: 'platform-chat-1', runId: 'run-1' });
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ memo: { prompt: 'hi' } }));
  });

  it('sends an operator turn as a signal', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ signal });
    const res = await handleSendTurn(depsWith({ getHandle } as never), 'chat-1', jsonReq({ text: 'check logs' }));
    expect(res.status).toBe(202);
    expect(signal).toHaveBeenCalledWith('userTurn', 'check logs');
  });

  it('rejects an empty turn with 400', async () => {
    const getHandle = vi.fn();
    const res = await handleSendTurn(depsWith({ getHandle } as never), 'chat-1', jsonReq({ text: '' }));
    expect(res.status).toBe(400);
    expect(getHandle).not.toHaveBeenCalled();
  });

  it('forwards a decision as a signal', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ signal });
    const res = await handleDecision(depsWith({ getHandle } as never), 'chat-1', jsonReq({ proposalId: 'p-2', approve: true }));
    expect(res.status).toBe(202);
    expect(signal).toHaveBeenCalledWith('decision', { proposalId: 'p-2', approve: true });
  });

  it('returns the conversation state for a running chat', async () => {
    const query = vi.fn().mockResolvedValue({
      chatId: 'chat-1',
      phase: 'awaiting-user',
      messages: [{ seq: 1, role: 'user', text: 'hi' }],
    });
    const getHandle = vi.fn().mockReturnValue({ describe: async () => ({ status: { name: 'RUNNING' } }), query });
    const res = await handleGetChat(depsWith({ getHandle } as never), 'chat-1');
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe('awaiting-user');
  });

  it('returns a closed state when the workflow has completed', async () => {
    const getHandle = vi.fn().mockReturnValue({ describe: async () => ({ status: { name: 'COMPLETED' } }) });
    const res = await handleGetChat(depsWith({ getHandle } as never), 'chat-1');
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe('closed');
  });

  it('404s an unknown chat', async () => {
    const getHandle = vi.fn().mockReturnValue({
      describe: async () => {
        throw new Error('not found');
      },
    });
    const res = await handleGetChat(depsWith({ getHandle } as never), 'nope');
    expect(res.status).toBe(404);
  });
});