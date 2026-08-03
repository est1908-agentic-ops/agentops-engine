import { z } from 'zod';
import { ManagedProjectSchema } from './managed-project';

// GET /api/projects — list. The console is read-only (the write CRUD --
// POST/PUT/DELETE -- was retired once the engine started resolving projects
// from the mounted managed-projects ConfigMap; see
// docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md).
// Reuses ManagedProjectSchema, which carries `credentialSet: boolean` and
// never the token (design §7: no tokens, ever).
export const ManagedProjectListResponseSchema = z.array(ManagedProjectSchema);
export type ManagedProjectListResponse = z.infer<typeof ManagedProjectListResponseSchema>;
