import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  InvalidProjectConfigError,
  parseProjectConfig,
  type ManagedProject,
  type ManagedProjectStore,
  type ProjectConfig,
} from '@agentops/contracts';
import { normalizeRepo, parseRepoSlug } from '@agentops/ports';

const CONFIG_FILE_SUFFIX = '__agentops.json';

// Slugs are `[a-z0-9-]` (see the shared ConfigMap-key contract in
// docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md) --
// `__` is therefore an unambiguous separator between the slug and the file
// kind. Anything that doesn't match this exact shape (e.g. a Kubernetes
// ConfigMap volume's own housekeeping entries like `..data` / `..2024_.../`
// symlinks) is silently skipped rather than tripping a parse error.
const PROJECT_FILE_PATTERN = /^([a-z0-9-]+)__project\.yaml$/;

interface RawManagedProjectFile {
  project?: unknown;
  repo?: unknown;
  readRepositories?: unknown;
  tokenSecret?: unknown;
  trackerType?: unknown;
  linearTeamKey?: unknown;
  linearTriggerLabelId?: unknown;
  linearTokenSecret?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseReadRepositories(
  value: unknown,
  primaryRepo: string,
  entry: string,
  slug: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `FileManagedProjectStore: "${entry}" (slug "${slug}") field "readRepositories" must be an array`,
    );
  }

  const normalizedPrimaryRepo = normalizeRepo(primaryRepo).toLowerCase();
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(
        `FileManagedProjectStore: "${entry}" (slug "${slug}") field "readRepositories[${index}]" must be a non-empty string`,
      );
    }

    if (item !== item.trim()) {
      throw new Error(
        `FileManagedProjectStore: "${entry}" (slug "${slug}") field "readRepositories[${index}]" must be a short owner/name repository`,
      );
    }
    try {
      parseRepoSlug(item);
    } catch {
      throw new Error(
        `FileManagedProjectStore: "${entry}" (slug "${slug}") field "readRepositories[${index}]" must be a short owner/name repository`,
      );
    }
    const normalizedRepo = normalizeRepo(item).toLowerCase();
    if (normalizedRepo === normalizedPrimaryRepo) {
      throw new Error(
        `FileManagedProjectStore: "${entry}" (slug "${slug}") field "readRepositories" must not include the primary repository`,
      );
    }
    if (seen.has(normalizedRepo)) {
      throw new Error(
        `FileManagedProjectStore: "${entry}" (slug "${slug}") field "readRepositories" contains a duplicate repository`,
      );
    }
    seen.add(normalizedRepo);
    return normalizedRepo;
  });
}

/**
 * Reads per-project files from a directory mounted from the `managed-projects`
 * ConfigMap (`/etc/managed-projects` in cluster; a temp dir in tests):
 * `<slug>__project.yaml` (required -- `project`/`repo`/`tokenSecret`) and
 * `<slug>__agentops.json` (optional -- may be PARTIAL, just like the in-repo
 * agentops.json `loadProjectConfig` reads: this store runs it through
 * `parseProjectConfig`, the same DEFAULT_PROJECT_CONFIG-merge-then-validate
 * step, so `managedProject.config` is always a COMPLETE ProjectConfig, never
 * a raw partial patch. This matters because `resolveProjectConfig` returns
 * `managedProject.config` straight through with no further defaulting step.
 * Absent file means "fall back to the in-repo agentops.json", which is
 * resolveProjectConfig's job, not this class's).
 *
 * `tokenSecret` names the Kubernetes Secret holding this project's GitHub
 * token (per-project, not a single shared `GITHUB_TOKEN` -- that shared-env
 * design was superseded). It's exposed on the returned `ManagedProject` so
 * `resolveManagedProjectEntry` can hand it to a token resolver (e.g.
 * `KubeTokenResolver`) that reads the Secret by name; this store itself never
 * reads the Secret or sees the token value.
 *
 * Read-only and refreshable: each lookup reads the directory again. Kubernetes
 * updates projected ConfigMap volumes in place, so worker and gateway processes
 * observe registry changes without a rollout or cross-Application sync ordering.
 * The registry is small and lookups happen at workflow/webhook boundaries, not
 * in an inner execution loop, making fresh reads preferable to stale caching.
 */
export class FileManagedProjectStore implements ManagedProjectStore {
  constructor(private readonly dir: string) {}

  private load(): Promise<{
    byRepo: Map<string, ManagedProject>;
    byLinearTeamKey: Map<string, ManagedProject>;
  }> {
    return this.readAll();
  }

  private async readAll(): Promise<{
    byRepo: Map<string, ManagedProject>;
    byLinearTeamKey: Map<string, ManagedProject>;
  }> {
    const entries = await readdir(this.dir);
    const entrySet = new Set(entries);
    const byRepo = new Map<string, ManagedProject>();
    const byLinearTeamKey = new Map<string, ManagedProject>();

    for (const entry of entries) {
      const match = PROJECT_FILE_PATTERN.exec(entry);
      if (!match) {
        continue;
      }
      const slug = match[1];

      try {
        let rawProject: unknown;
        try {
          rawProject = parseYaml(await readFile(join(this.dir, entry), 'utf8'));
        } catch (err) {
          throw new Error(
            `FileManagedProjectStore: failed to parse "${entry}" (slug "${slug}"): ${(err as Error).message}`,
            { cause: err },
          );
        }
        const parsedProject = rawProject as RawManagedProjectFile | null;
        if (
          typeof parsedProject !== 'object' ||
          parsedProject === null ||
          !isNonEmptyString(parsedProject.project) ||
          !isNonEmptyString(parsedProject.repo)
        ) {
          throw new Error(
            `FileManagedProjectStore: "${entry}" (slug "${slug}") must have non-empty string "project" and "repo" fields`,
          );
        }

        const trackerType = parsedProject.trackerType === 'linear' ? 'linear' : 'github';

        if (trackerType === 'linear') {
          // Linear tracker: validate Linear-specific fields
          if (!isNonEmptyString(parsedProject.linearTeamKey)) {
            throw new Error(
              `FileManagedProjectStore: "${entry}" (slug "${slug}") with trackerType "linear" must have a non-empty string "linearTeamKey" field`,
            );
          }
          // Linear projects also need tokenSecret for the GitHub/Linear API resolver
          if (!isNonEmptyString(parsedProject.tokenSecret)) {
            throw new Error(
              `FileManagedProjectStore: "${entry}" (slug "${slug}") with trackerType "linear" must have non-empty string "tokenSecret" field`,
            );
          }
        } else {
          // GitHub tracker: validate GitHub-specific fields
          if (!isNonEmptyString(parsedProject.tokenSecret)) {
            throw new Error(
              `FileManagedProjectStore: "${entry}" (slug "${slug}") with trackerType "github" must have non-empty string "tokenSecret" field`,
            );
          }
        }

        const configFileName = `${slug}${CONFIG_FILE_SUFFIX}`;
        let config: ProjectConfig | null = null;
        if (entrySet.has(configFileName)) {
          let rawConfig: unknown;
          try {
            rawConfig = JSON.parse(await readFile(join(this.dir, configFileName), 'utf8'));
          } catch (err) {
            throw new Error(
              `FileManagedProjectStore: "${configFileName}" (slug "${slug}") is not valid JSON: ${(err as Error).message}`,
              { cause: err },
            );
          }
          try {
            config = parseProjectConfig(rawConfig);
          } catch (err) {
            if (err instanceof InvalidProjectConfigError) {
              throw new InvalidProjectConfigError(
                `FileManagedProjectStore: "${configFileName}" (slug "${slug}"): ${err.message}`,
                err.issues,
              );
            }
            throw err;
          }
        }

        const repo = normalizeRepo(parsedProject.repo);
        const readRepositories = parseReadRepositories(
          parsedProject.readRepositories,
          repo,
          entry,
          slug,
        );
        // id/createdAt/updatedAt are DB-row artifacts of ManagedProjectSchema
        // that have no meaning for a file-backed, read-only store -- the slug
        // stands in for id (stable and unique per the ConfigMap key contract)
        // and a fixed epoch stands in for the timestamps. This object is never
        // run through ManagedProjectSchema.parse() (id isn't a real UUID), the
        // same "constructed, not re-validated" convention ResolvedProjectEntry
        // already uses.
        const baseFields = {
          id: slug,
          project: parsedProject.project,
          repo,
          readRepositories,
          config,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };

        let managedProject: ManagedProject;
        if (trackerType === 'linear') {
          managedProject = {
            ...baseFields,
            trackerType: 'linear',
            credentialSet: true,
            tokenSecret: parsedProject.tokenSecret as string,
            linearTeamKey: parsedProject.linearTeamKey as string,
            ...(isNonEmptyString(parsedProject.linearTriggerLabelId)
              ? { linearTriggerLabelId: parsedProject.linearTriggerLabelId }
              : {}),
            linearCredentialSet: true,
            linearTokenSecret: isNonEmptyString(parsedProject.linearTokenSecret)
              ? (parsedProject.linearTokenSecret as string)
              : undefined,
          };
          byLinearTeamKey.set(managedProject.linearTeamKey, managedProject);
        } else {
          managedProject = {
            ...baseFields,
            trackerType: 'github',
            credentialSet: true,
            tokenSecret: parsedProject.tokenSecret as string,
          };
        }
        byRepo.set(repo, managedProject);
      } catch (err) {
        console.warn(
          `FileManagedProjectStore: skipping "${entry}" (slug "${slug}"): ${(err as Error).message}`,
        );
      }
    }

    return { byRepo, byLinearTeamKey };
  }

  async get(repo: string): Promise<ManagedProject | null> {
    const { byRepo } = await this.load();
    return byRepo.get(normalizeRepo(repo)) ?? null;
  }

  /** Lookup by the unique `project` name. */
  async getByProject(project: string): Promise<ManagedProject | null> {
    const { byRepo } = await this.load();
    for (const managedProject of byRepo.values()) {
      if (managedProject.project === project) {
        return managedProject;
      }
    }
    return null;
  }

  async getByLinearTeamKey(teamKey: string): Promise<ManagedProject | null> {
    const { byLinearTeamKey } = await this.load();
    return byLinearTeamKey.get(teamKey) ?? null;
  }

  async list(): Promise<ManagedProject[]> {
    const { byRepo } = await this.load();
    return [...byRepo.values()].sort((a, b) => a.project.localeCompare(b.project));
  }
}
