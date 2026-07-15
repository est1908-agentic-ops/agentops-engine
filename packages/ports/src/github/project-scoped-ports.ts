import type { GitCommandRunner } from '../git/git-command-runner';
import type { ScmPort } from '../scm-port';
import type { TrackerPort } from '../tracker-port';
import { parseTrackerRef } from '../tracker-ref';
import { normalizeRepo, parseRef } from './parse-ref';

export interface ProjectScopedPortsEntry {
  repo: string;
  // Only set for Linear-tracked projects -- routes TrackerPort calls whose
  // ref is Linear-shaped (see parseTrackerRef) to this entry. SCM/git are
  // always keyed by `repo` regardless of tracker: PRs/worktrees live on the
  // GitHub side even when the issue came from Linear.
  linearTeamKey?: string;
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
  const byLinearTeamKey = new Map(
    entries
      .filter((entry) => entry.linearTeamKey)
      .map((entry) => [entry.linearTeamKey as string, entry]),
  );

  function resolve(repo: string): ProjectScopedPortsEntry {
    const found = byRepo.get(normalizeRepo(repo));
    if (!found) {
      throw new Error(
        `createProjectScopedPorts: no project registered for repo "${repo}" — check the project registry`,
      );
    }
    return found;
  }

  // Tracker refs route by whichever key the ref's own shape identifies
  // (GitHub ref → repo, Linear ref → team key) rather than always assuming a
  // GitHub-shaped ref — see docs/superpowers/specs/2026-07-09-linear-trigger-design.md.
  function resolveByTrackerRef(ref: string): ProjectScopedPortsEntry {
    const parsed = parseTrackerRef(ref);
    if (parsed.kind === 'github') {
      return resolve(parsed.repo);
    }
    const found = byLinearTeamKey.get(parsed.teamKey);
    if (!found) {
      throw new Error(
        `createProjectScopedPorts: no project registered for Linear team "${parsed.teamKey}" — check the project registry`,
      );
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
      getPrSnapshot: async (prRef) => resolve(repoFromRef(prRef)).scm.getPrSnapshot(prRef),
      mergePr: async (req) => resolve(repoFromRef(req.prRef)).scm.mergePr(req),
      push: async (repo, workspaceRef, branch, contentHash) =>
        resolve(repo).scm.push(repo, workspaceRef, branch, contentHash),
      readFile: async (repo, path) => resolve(repo).scm.readFile(repo, path),
    },
    tracker: {
      getIssue: async (ref) => resolveByTrackerRef(ref).tracker.getIssue(ref),
      comment: async (ref, body) => resolveByTrackerRef(ref).tracker.comment(ref, body),
      label: async (ref, label) => resolveByTrackerRef(ref).tracker.label(ref, label),
      removeLabel: async (ref, label) => resolveByTrackerRef(ref).tracker.removeLabel(ref, label),
      createIssue: async (req) => resolve(req.repo).tracker.createIssue(req),
    },
    resolveGit: (repo) => resolve(repo).git,
  };
}
