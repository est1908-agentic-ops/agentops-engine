export interface ParsedRef {
  owner: string;
  repo: string;
  number: number;
}

export function parseRef(ref: string): ParsedRef {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!match) {
    throw new Error(`parseRef: expected "owner/repo#number", got "${ref}"`);
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * Canonicalizes a repository identifier to the short `owner/repo` form the
 * engine uses everywhere else: GitHub webhook events (`event.repo`), issue refs
 * (`owner/repo#n`), the static PROJECT_REGISTRY_JSON, and `githubCloneUrl`
 * (which does `https://github.com/${repo}.git`) all assume it. Managed projects
 * registered through the /api/projects CRUD can carry a full browser/clone URL
 * ("https://github.com/owner/repo(.git)") or SSH URL ("git@github.com:owner/repo.git");
 * left as-is those never match the short-form lookups and every task for that
 * project fails with `no project registered for repo "..."`. Idempotent on
 * already-short input.
 */
export function normalizeRepo(repo: string): string {
  return repo
    .trim()
    .replace(/^git@[^:]+:/, '') // git@github.com:owner/repo(.git)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '') // https://github.com/owner/repo(.git)
    .replace(/\.git$/, '') // drop a .git suffix
    .replace(/\/+$/, ''); // drop trailing slash(es)
}

export interface ParsedRepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(repo: string): ParsedRepoSlug {
  const match = /^([^/]+)\/([^/#]+)$/.exec(repo);
  if (!match) {
    throw new Error(`parseRepoSlug: expected "owner/repo", got "${repo}"`);
  }
  return { owner: match[1], repo: match[2] };
}
