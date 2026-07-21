import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_QUEUE } from '@agentops/contracts';

const REFERENCE_ROOT = join(__dirname, '../docs/project-worker');

describe('Tier-2 project worker (reference + e2e placeholder)', () => {
  it('ENGINE_QUEUE is available for Tier-2', () => {
    expect(ENGINE_QUEUE).toBe('agentops-engine');
  });

  it('reference example exists on disk', () => {
    expect(existsSync(join(REFERENCE_ROOT, 'agentops/worker.ts'))).toBe(true);
    expect(existsSync(join(REFERENCE_ROOT, 'agentops/workflows/rollbar-monitor.ts'))).toBe(true);
    expect(existsSync(join(REFERENCE_ROOT, 'agentops.json'))).toBe(true);
  });
});
