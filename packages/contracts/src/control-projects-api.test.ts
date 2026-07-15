import { describe, expect, it } from 'vitest';
import {
  CreateManagedProjectRequestSchema,
  UpdateManagedProjectRequestSchema,
  ManagedProjectListResponseSchema,
} from './control-projects-api';

describe('CreateManagedProjectRequestSchema', () => {
  it('requires project, repo, and a non-empty token', () => {
    expect(() =>
      CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: '' }),
    ).toThrow();
    expect(() =>
      CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web' }),
    ).toThrow();
  });

  it('accepts a minimal create body', () => {
    const parsed = CreateManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      token: 'ghp_abc',
    });
    expect(parsed.config).toBeUndefined();
  });

  it('accepts an explicit null config to register file-based on create', () => {
    const parsed = CreateManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      token: 'ghp_abc',
      config: null,
    });
    expect(parsed.config).toBeNull();
  });

  it('accepts a full config object', () => {
    const config = {
      stages: {},
      routing: {},
      brakes: {
        maxImplementAttempts: 3,
        maxIterations: 6,
        maxTokens: 200_000,
        maxBabysitRounds: 5,
      },
    };
    const parsed = CreateManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      token: 'ghp_abc',
      config,
    });
    expect(parsed.config?.brakes.maxTokens).toBe(200_000);
  });

  it('defaults trackerType to github when omitted', () => {
    const parsed = CreateManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      token: 'ghp_abc',
    });
    expect(parsed.trackerType).toBe('github');
  });

  it('accepts a linear-tracked create with all linear fields present', () => {
    const parsed = CreateManagedProjectRequestSchema.parse({
      project: 'acme-web',
      repo: 'acme/web',
      token: 'ghp_abc',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTriggerLabelId: 'label-uuid',
      linearToken: 'lin_fake',
    });
    expect(parsed.linearTeamKey).toBe('ENG');
  });

  it('rejects a linear-tracked create missing any linear field', () => {
    const base = {
      project: 'acme-web',
      repo: 'acme/web',
      token: 'ghp_abc',
      trackerType: 'linear' as const,
    };
    expect(() =>
      CreateManagedProjectRequestSchema.parse({
        ...base,
        linearTriggerLabelId: 'x',
        linearToken: 'y',
      }),
    ).toThrow();
    expect(() =>
      CreateManagedProjectRequestSchema.parse({ ...base, linearTeamKey: 'ENG', linearToken: 'y' }),
    ).toThrow();
    expect(() =>
      CreateManagedProjectRequestSchema.parse({
        ...base,
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'x',
      }),
    ).toThrow();
  });
});

describe('UpdateManagedProjectRequestSchema', () => {
  it('allows an empty body (a no-op update)', () => {
    const parsed = UpdateManagedProjectRequestSchema.parse({});
    expect(parsed.token).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  it('accepts a token rotation', () => {
    expect(UpdateManagedProjectRequestSchema.parse({ token: 'ghp_new' }).token).toBe('ghp_new');
  });

  it('distinguishes null (clear config) from omitted (keep config)', () => {
    expect(UpdateManagedProjectRequestSchema.parse({ config: null }).config).toBeNull();
    expect(UpdateManagedProjectRequestSchema.parse({}).config).toBeUndefined();
  });

  it('rejects an empty token string', () => {
    expect(() => UpdateManagedProjectRequestSchema.parse({ token: '' })).toThrow();
  });

  it('has no project or repo field — those are immutable identity', () => {
    // Parsing extra keys does not error (zod strips them by default), but the
    // *type* carries no project/repo; assert the parsed result has none.
    const parsed = UpdateManagedProjectRequestSchema.parse({ project: 'sneaky', token: 'ghp_x' });
    expect((parsed as Record<string, unknown>).project).toBeUndefined();
  });
});

describe('ManagedProjectListResponseSchema', () => {
  it('parses a list of managed projects (no token field is present on items)', () => {
    const parsed = ManagedProjectListResponseSchema.parse([
      {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        project: 'acme-web',
        repo: 'acme/web',
        trackerType: 'github',
        credentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].credentialSet).toBe(true);
    expect((parsed[0] as unknown as Record<string, unknown>).token).toBeUndefined();
    expect((parsed[0] as unknown as Record<string, unknown>).encryptedToken).toBeUndefined();
  });

  it('parses a mixed list of github- and linear-tracked projects', () => {
    const parsed = ManagedProjectListResponseSchema.parse([
      {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        project: 'acme-web',
        repo: 'acme/web',
        trackerType: 'github',
        credentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      },
      {
        id: '4fa85f64-5717-4562-b3fc-2c963f66afa7',
        project: 'acme-linear',
        repo: 'acme/linear-tracked',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        credentialSet: true,
        linearCredentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].trackerType).toBe('linear');
  });
});
