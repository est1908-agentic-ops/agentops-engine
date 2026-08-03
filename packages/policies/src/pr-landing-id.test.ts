import { describe, expect, it } from 'vitest';
import { prLandingWorkflowId } from './pr-landing-id';

describe('prLandingWorkflowId', () => {
  it('normalizes PR refs to deterministic workflow IDs', () => {
    expect(prLandingWorkflowId('Octo-Cat/Hello.World#42')).toBe(
      'pr-landing-octo-cat-hello-world-42',
    );
  });
});
