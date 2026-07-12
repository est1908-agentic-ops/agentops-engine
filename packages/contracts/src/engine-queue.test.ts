import { describe, it, expect } from 'vitest';
import { ENGINE_QUEUE, LEGACY_ENGINE_QUEUE } from './engine-queue';

describe('ENGINE_QUEUE', () => {
  it('is the canonical engine queue name', () => {
    expect(ENGINE_QUEUE).toBe('agentops-engine');
  });
  it('exposes the legacy name for the one-time cutover', () => {
    expect(LEGACY_ENGINE_QUEUE).toBe('agentops-devcycle');
  });
});
