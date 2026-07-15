import { describe, expect, it } from 'vitest';
import { ManagedProjectSchema, UpsertManagedProjectRequestSchema } from './managed-project';

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

  it('parses a valid linear-tracked project', () => {
    const parsed = ManagedProjectSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTriggerLabelId: 'label-uuid',
      credentialSet: true,
      linearCredentialSet: true,
      config: null,
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    });
    expect(parsed.trackerType).toBe('linear');
    if (parsed.trackerType === 'linear') {
      expect(parsed.linearTeamKey).toBe('ENG');
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

describe('UpsertManagedProjectRequestSchema', () => {
  it('allows omitting token and config for an update', () => {
    const parsed = UpsertManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
    });
    expect(parsed.token).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  it('defaults trackerType to github when omitted', () => {
    const parsed = UpsertManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
    });
    expect(parsed.trackerType).toBe('github');
  });

  it('accepts an explicit null config to clear it back to file-based', () => {
    const parsed = UpsertManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      config: null,
    });
    expect(parsed.config).toBeNull();
  });

  it('rejects an empty token string', () => {
    expect(() =>
      UpsertManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: '' }),
    ).toThrow();
  });

  it('accepts linear fields alongside trackerType: linear', () => {
    const parsed = UpsertManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTriggerLabelId: 'label-uuid',
      linearToken: 'lin_fake',
    });
    expect(parsed.linearTeamKey).toBe('ENG');
  });
});
