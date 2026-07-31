import { z } from 'zod';
import { GitRefNameSchema } from './git-ref';

const ShortRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must be in owner/name form.');

const RepositoryRelativePathSchema = z
  .string()
  .regex(
    /^repositories\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'Repository checkout path must be under repositories/owner/name.',
  );

export const RepositorySessionRepositoryInputSchema = z
  .object({
    repo: ShortRepositorySchema,
    ref: GitRefNameSchema.optional(),
  })
  .strict();
export type RepositorySessionRepositoryInput = z.infer<typeof RepositorySessionRepositoryInputSchema>;

export const CreateRepositorySessionRequestSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    repositories: z.array(RepositorySessionRepositoryInputSchema).min(1).max(5),
  })
  .strict()
  .superRefine(({ repositories }, context) => {
    const seen = new Set<string>();

    repositories.forEach(({ repo }, index) => {
      const normalizedRepo = repo.toLowerCase();
      if (seen.has(normalizedRepo)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Repositories must be distinct, ignoring case.',
          path: ['repositories', index, 'repo'],
        });
      }
      seen.add(normalizedRepo);
    });
  });
export type CreateRepositorySessionRequest = z.infer<typeof CreateRepositorySessionRequestSchema>;

export const RepositorySessionRepositorySchema = z
  .object({
    repo: ShortRepositorySchema,
    relativePath: RepositoryRelativePathSchema,
    commit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
export type RepositorySessionRepository = z.infer<typeof RepositorySessionRepositorySchema>;

export const RepositorySessionSchema = z
  .object({
    workspaceRef: z.string().min(1),
    repositories: z.array(RepositorySessionRepositorySchema).min(1).max(5),
  })
  .strict();
export type RepositorySession = z.infer<typeof RepositorySessionSchema>;

export const CleanupRepositorySessionRequestSchema = z.object({ workspaceRef: z.string().min(1) }).strict();
export type CleanupRepositorySessionRequest = z.infer<typeof CleanupRepositorySessionRequestSchema>;
