import { describe, expect, it } from 'vitest';
import {
  CleanupRepositorySessionRequestSchema,
  CreateRepositorySessionRequestSchema,
  RepositorySessionSchema,
} from './repository-session';

describe('CreateRepositorySessionRequestSchema', () => {
  it('accepts one to five distinct short-form repositories', () => {
    expect(
      CreateRepositorySessionRequestSchema.parse({
        taskId: 'rollbar-123',
        repositories: [{ repo: 'flair-hr/employee-hub-monorepo' }],
      }).repositories,
    ).toHaveLength(1);

    const parsed = CreateRepositorySessionRequestSchema.parse({
      taskId: 'rollbar-123',
      repositories: [
        { repo: 'flair-hr/employee-hub-monorepo' },
        { repo: 'flair-hr/shared-contracts' },
        { repo: 'acme/api' },
        { repo: 'acme/web' },
        { repo: 'acme/docs' },
      ],
    });

    expect(parsed.repositories).toHaveLength(5);
  });

  it('accepts an optional validated Git ref', () => {
    const parsed = CreateRepositorySessionRequestSchema.parse({
      taskId: 'rollbar-123',
      repositories: [{ repo: 'flair-hr/shared-contracts', ref: 'feature/session-support' }],
    });

    expect(parsed.repositories[0].ref).toBe('feature/session-support');
  });

  it('rejects full repository URLs', () => {
    expect(
      CreateRepositorySessionRequestSchema.safeParse({
        taskId: 'rollbar-123',
        repositories: [{ repo: 'https://github.com/acme/app' }],
      }).success,
    ).toBe(false);
  });

  it('rejects repository duplicates case-insensitively', () => {
    expect(
      CreateRepositorySessionRequestSchema.safeParse({
        taskId: 'rollbar-123',
        repositories: [{ repo: 'Acme/App' }, { repo: 'acme/app' }],
      }).success,
    ).toBe(false);
  });

  it('requires between one and five repositories', () => {
    expect(
      CreateRepositorySessionRequestSchema.safeParse({ taskId: 'rollbar-123', repositories: [] }).success,
    ).toBe(false);
    expect(
      CreateRepositorySessionRequestSchema.safeParse({
        taskId: 'rollbar-123',
        repositories: Array.from({ length: 6 }, (_, index) => ({ repo: `acme/app-${index}` })),
      }).success,
    ).toBe(false);
  });

  it('rejects malformed repository names and unsafe Git refs', () => {
    expect(
      CreateRepositorySessionRequestSchema.safeParse({
        taskId: 'rollbar-123',
        repositories: [{ repo: 'acme/app/extra' }],
      }).success,
    ).toBe(false);
    expect(
      CreateRepositorySessionRequestSchema.safeParse({
        taskId: 'rollbar-123',
        repositories: [{ repo: 'acme/app', ref: '--upload-pack=x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown request fields', () => {
    expect(
      CreateRepositorySessionRequestSchema.safeParse({
        taskId: 'rollbar-123',
        repositories: [{ repo: 'acme/app' }],
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe('RepositorySessionSchema', () => {
  it('requires a lowercase 40-character commit and a safe repository checkout path', () => {
    const session = {
      workspaceRef: '/workspace/tasks/repository-sessions/acme/task',
      repositories: [
        {
          repo: 'acme/app',
          relativePath: 'repositories/acme/app',
          commit: 'a'.repeat(40),
        },
      ],
    };

    expect(RepositorySessionSchema.safeParse(session).success).toBe(true);
    expect(
      RepositorySessionSchema.safeParse({
        ...session,
        repositories: [{ ...session.repositories[0], commit: 'A'.repeat(40) }],
      }).success,
    ).toBe(false);
    expect(
      RepositorySessionSchema.safeParse({
        ...session,
        repositories: [{ ...session.repositories[0], relativePath: '../acme/app' }],
      }).success,
    ).toBe(false);
  });
});

describe('CleanupRepositorySessionRequestSchema', () => {
  it('requires a nonempty workspace reference', () => {
    expect(CleanupRepositorySessionRequestSchema.safeParse({ workspaceRef: '/workspace/task' }).success).toBe(
      true,
    );
    expect(CleanupRepositorySessionRequestSchema.safeParse({ workspaceRef: '' }).success).toBe(false);
  });
});
