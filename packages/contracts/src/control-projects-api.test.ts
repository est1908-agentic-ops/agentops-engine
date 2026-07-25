import { describe, expect, it } from 'vitest';
import { ManagedProjectListResponseSchema } from './control-projects-api';

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
