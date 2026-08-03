import type { ManagedProject } from './managed-project';

/**
 * Read-only lookup surface consumers actually call -- extracted from
 * PostgresManagedProjectStore so a non-DB-backed implementation (e.g. a
 * ConfigMap-directory-backed store) can satisfy the same shape. Write
 * methods (`upsert`/`remove`) and the encrypted-credential getters
 * (`getEncryptedToken`/`getEncryptedLinearToken`) are DB/crypto-specific and
 * stay off this interface -- callers depend on it for lookups only.
 *
 * Linear resolution is back and resolved by team key against the ConfigMap store.
 * See docs/superpowers/specs/issue-agentic-ops-engine-169-design.md.
 */
export interface ManagedProjectStore {
  get(repo: string): Promise<ManagedProject | null>;
  getByProject(project: string): Promise<ManagedProject | null>;
  getByLinearTeamKey(teamKey: string): Promise<ManagedProject | null>;
  list(): Promise<ManagedProject[]>;
}
