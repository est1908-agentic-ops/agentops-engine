import type { GitCommandRunner } from '../git/git-command-runner';
import type { ScmPort } from '../scm-port';
import type { TrackerPort } from '../tracker-port';
import { normalizeRepo, parseRef } from './parse-ref';

export interface ProjectScopedPortsEntry {
  repo: string;
  scm: ScmPort;
  tracker: TrackerPort;
  git: GitCommandRunner;
}

export interface ProjectScopedPorts {
  scm: ScmPort;
  tracker: TrackerPort;
  resolveGit: (repo: string) => GitCommandRunner;
}

function repoFromRef(ref: string): string {
  const { owner, repo } = parseRef(ref);
  return `${owner}/${repo}`;
}

export function createProjectScopedPorts(entries: ProjectScopedPortsEntry[]): ProjectScopedPorts {
  // Key and look up by the canonical `owner/repo` form so an entry registered
  // with a full URL (e.g. a managed project stored as
  // "https://github.com/owner/repo") still matches a short-form lookup, and
  // vice versa -- otherwise the exact-string Map miss surfaces as
  // "no project registered for repo ...".
  const byRepo = new Map(entries.map((entry) => [normalizeRepo(entry.repo), entry]));

  function resolve(repo: string): ProjectScopedPortsEntry {
    const found = byRepo.get(normalizeRepo(repo));
    if (!found) {
      throw new Error(`createProjectScopedPorts: no project registered for repo "${repo}" — check the project registry`);
    }
    return found;
  }

  return {
    scm: {
      // async here isn't just style: resolve() throws synchronously on an unregistered
      // repo, and wrapping the call in an async function turns that throw into a
      // rejected promise (matching every other ScmPort/TrackerPort method's contract)
      // instead of an uncaught synchronous exception from the dispatcher.
      openPr: async (req) => resolve(req.repo).scm.openPr(req),
      getPrFeedback: async (prRef) => resolve(repoFromRef(prRef)).scm.getPrFeedback(prRef),
      push: async (repo, workspaceRef, branch, contentHash) =>
        resolve(repo).scm.push(repo, workspaceRef, branch, contentHash),
      readFile: async (repo, path) => resolve(repo).scm.readFile(repo, path),
    },
    tracker: {
      getIssue: async (ref) => resolve(repoFromRef(ref)).tracker.getIssue(ref),
      comment: async (ref, body) => resolve(repoFromRef(ref)).tracker.comment(ref, body),
      label: async (ref, label) => resolve(repoFromRef(ref)).tracker.label(ref, label),
    },
    resolveGit: (repo) => resolve(repo).git,
  };
}
