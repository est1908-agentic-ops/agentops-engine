import { describe, expect, it } from 'vitest';
import { ManagedProjectSchema } from './managed-project';

describe('ManagedProjectSchema', () => {
  it('parses a valid github-tracked project with a null config', () => {
    const parsed = ManagedProjectSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'github',
      credentialSet: true,
      config: null,
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    });
    expect(parsed.project).toBe('acme-web');
    expect(parsed.config).toBeNull();
  });

  it('parses a valid github-tracked project with a set config', () => {
    const parsed = ManagedProjectSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'github',
      credentialSet: true,
      config: {
        stages: {},
        routing: {},
        brakes: {
          maxImplementAttempts: 3,
          maxIterations: 6,
          maxTokens: 200_000,
          maxBabysitRounds: 5,
        },
      },
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    });
    expect(parsed.config?.brakes.maxTokens).toBe(200_000);
  });

  it('parses a Linear-tracked project without webhook trigger configuration', () => {
    const parsed = ManagedProjectSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      credentialSet: true,
      linearCredentialSet: true,
      config: null,
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    });
    expect(parsed.trackerType).toBe('linear');
    if (parsed.trackerType === 'linear') {
      expect(parsed.linearTeamKey).toBe('ENG');
      expect(parsed.linearTriggerLabelId).toBeUndefined();
    }
  });

  it('rejects a linear-tracked project missing linearTeamKey', () => {
    expect(() =>
      ManagedProjectSchema.parse({
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        project: 'acme-web',
        repo: 'acme/web',
        trackerType: 'linear',
        linearTriggerLabelId: 'label-uuid',
        credentialSet: true,
        linearCredentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects a missing repo', () => {
    expect(() =>
      ManagedProjectSchema.parse({
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        project: 'acme-web',
        trackerType: 'github',
        credentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      }),
    ).toThrow();
  });
});
