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
import { normalizeRepo } from '@agentops/ports';

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
  tokenSecret?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
 * Read-only and read-once: the directory is loaded lazily on first call and
 * cached for the process lifetime. A ConfigMap volume mount is refreshed by
 * the kubelet in the background, but this store never re-reads it after
 * first load -- a pod restart, not a live re-read, is how a ConfigMap change
 * reaches the process (matches how the worker/gateway boot-load the
 * registry once, per the Phase-2 platform plan).
 */
export class FileManagedProjectStore implements ManagedProjectStore {
  private cache: Promise<Map<string, ManagedProject>> | null = null;

  constructor(private readonly dir: string) {}

  private load(): Promise<Map<string, ManagedProject>> {
    if (!this.cache) {
      this.cache = this.readAll();
    }
    return this.cache;
  }

  private async readAll(): Promise<Map<string, ManagedProject>> {
    const entries = await readdir(this.dir);
    const entrySet = new Set(entries);
    const byRepo = new Map<string, ManagedProject>();

    for (const entry of entries) {
      const match = PROJECT_FILE_PATTERN.exec(entry);
      if (!match) {
        continue;
      }
      const slug = match[1];

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
        !isNonEmptyString(parsedProject.repo) ||
        !isNonEmptyString(parsedProject.tokenSecret)
      ) {
        throw new Error(
          `FileManagedProjectStore: "${entry}" (slug "${slug}") must have non-empty string "project", "repo", and "tokenSecret" fields`,
        );
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
      // id/createdAt/updatedAt are DB-row artifacts of ManagedProjectSchema
      // that have no meaning for a file-backed, read-only store -- the slug
      // stands in for id (stable and unique per the ConfigMap key contract)
      // and a fixed epoch stands in for the timestamps. This object is never
      // run through ManagedProjectSchema.parse() (id isn't a real UUID), the
      // same "constructed, not re-validated" convention ResolvedProjectEntry
      // already uses.
      const managedProject: ManagedProject = {
        id: slug,
        project: parsedProject.project,
        repo,
        credentialSet: true,
        config,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        trackerType: 'github',
        tokenSecret: parsedProject.tokenSecret,
      };
      byRepo.set(repo, managedProject);
    }

    return byRepo;
  }

  async get(repo: string): Promise<ManagedProject | null> {
    const map = await this.load();
    return map.get(normalizeRepo(repo)) ?? null;
  }

  /** Lookup by the unique `project` name. */
  async getByProject(project: string): Promise<ManagedProject | null> {
    const map = await this.load();
    for (const managedProject of map.values()) {
      if (managedProject.project === project) {
        return managedProject;
      }
    }
    return null;
  }

  async list(): Promise<ManagedProject[]> {
    const map = await this.load();
    return [...map.values()].sort((a, b) => a.project.localeCompare(b.project));
  }
}
