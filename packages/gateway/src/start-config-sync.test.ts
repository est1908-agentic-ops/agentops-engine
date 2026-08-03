import { describe, expect, it, vi } from 'vitest';
import { startConfigSync } from './start-config-sync';

describe('startConfigSync', () => {
  it('starts configSync with id configsync:<project> (deduped)', async () => {
    const start = vi.fn().mockResolvedValue({});
    await startConfigSync({ workflow: { start } } as never, 'agentops-engine', 'acme', 'acme/web');
    const opts = start.mock.calls[0][1];
    expect(opts.workflowId).toBe('configsync:acme');
  });
});
