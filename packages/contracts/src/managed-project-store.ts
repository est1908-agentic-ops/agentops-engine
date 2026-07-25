import type { ManagedProject } from './managed-project';

/**
 * Read-only lookup surface consumers actually call -- extracted from
 * PostgresManagedProjectStore so a non-DB-backed implementation (e.g. a
 * ConfigMap-directory-backed store) can satisfy the same shape. Write
 * methods (`upsert`/`remove`) and the encrypted-credential getters
 * (`getEncryptedToken`/`getEncryptedLinearToken`) are DB/crypto-specific and
 * stay off this interface -- callers depend on it for lookups only.
 *
 * `getByLinearTeamKey` is intentionally omitted: Linear resolution is
 * retired against the file-backed store (see
 * docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md's
 * Global Constraints -- no homelab Linear project exists).
 */
export interface ManagedProjectStore {
  get(repo: string): Promise<ManagedProject | null>;
  getByProject(project: string): Promise<ManagedProject | null>;
  list(): Promise<ManagedProject[]>;
}
