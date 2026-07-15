import { describe, expect, it, vi } from 'vitest';
import type { PrFeedback } from '@agentops/contracts';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { ScmPort } from '../scm-port';
import type { TrackerPort } from '../tracker-port';
import { createProjectScopedPorts, type ProjectScopedPortsEntry } from './project-scoped-ports';

function fakeScm(): ScmPort {
  return {
    openPr: vi.fn().mockResolvedValue({ prRef: 'r#1', url: 'https://x' }),
    getPrFeedback: vi
      .fn()
      .mockResolvedValue({
        ciStatus: 'green',
        unresolvedThreads: 0,
        comments: [],
      } satisfies PrFeedback),
    getPrSnapshot: vi.fn().mockResolvedValue({
      prRef: 'owner/repo-b#7',
      headSha: 'abc',
      headRepo: 'owner/repo-b',
      headBranch: 'feature/x',
      checkoutRef: 'refs/pull/7/head',
      labels: [],
      state: 'open',
      draft: false,
      mergeable: true,
      mergedHeadSha: null,
      ciStatus: 'green',
      unresolvedThreads: 0,
      comments: [],
    }),
    mergePr: vi.fn().mockResolvedValue({ kind: 'merged', headSha: 'abc', mergeCommitSha: 'def' }),
    push: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('content'),
  };
}

function fakeTracker(): TrackerPort {
  return {
    getIssue: vi.fn().mockResolvedValue({ ref: 'r#1', title: 'T', body: 'B', labels: [] }),
    comment: vi.fn().mockResolvedValue(undefined),
    label: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ ref: 'o/r#1', url: 'https://x' }),
  };
}

function fakeGit(): GitCommandRunner {
  return { run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) };
}

function buildEntry(repo: string, linearTeamKey?: string): ProjectScopedPortsEntry {
  return { repo, linearTeamKey, scm: fakeScm(), tracker: fakeTracker(), git: fakeGit() };
}

describe('createProjectScopedPorts', () => {
  it('routes openPr to the entry matching req.repo', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm } = createProjectScopedPorts([entryA, entryB]);

    await scm.openPr({ repo: 'owner/repo-b', branch: 'b', title: 't', body: 'b' });

    expect(entryB.scm.openPr).toHaveBeenCalledTimes(1);
    expect(entryA.scm.openPr).not.toHaveBeenCalled();
  });

  it('resolves an entry registered with a full URL via a short-form lookup', async () => {
    // Managed projects registered through the CRUD can be stored as a full URL;
    // the runtime looks them up by the short owner/repo form.
    const entry = buildEntry('https://github.com/acme/webapp');
    const { scm, resolveGit } = createProjectScopedPorts([entry]);

    await scm.openPr({ repo: 'acme/webapp', branch: 'b', title: 't', body: 'b' });
    expect(() => resolveGit('acme/webapp')).not.toThrow();
    expect(entry.scm.openPr).toHaveBeenCalledTimes(1);
  });

  it('routes getPrFeedback/getIssue/comment/label by the repo parsed from the ref', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm, tracker } = createProjectScopedPorts([entryA, entryB]);

    await scm.getPrFeedback('owner/repo-b#7');
    await tracker.getIssue('owner/repo-a#3');
    await tracker.comment('owner/repo-a#3', 'hello');
    await tracker.label('owner/repo-b#7', 'bug');

    expect(entryB.scm.getPrFeedback).toHaveBeenCalledWith('owner/repo-b#7');
    expect(entryA.tracker.getIssue).toHaveBeenCalledWith('owner/repo-a#3');
    expect(entryA.tracker.comment).toHaveBeenCalledWith('owner/repo-a#3', 'hello');
    expect(entryB.tracker.label).toHaveBeenCalledWith('owner/repo-b#7', 'bug');
  });

  it('routes getPrSnapshot and mergePr by the repo parsed from prRef', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm } = createProjectScopedPorts([entryA, entryB]);

    await scm.getPrSnapshot('owner/repo-b#7');
    await scm.mergePr({ prRef: 'owner/repo-b#7', expectedHeadSha: 'abc' });

    expect(entryB.scm.getPrSnapshot).toHaveBeenCalledWith('owner/repo-b#7');
    expect(entryB.scm.mergePr).toHaveBeenCalledWith({
      prRef: 'owner/repo-b#7',
      expectedHeadSha: 'abc',
    });
    expect(entryA.scm.getPrSnapshot).not.toHaveBeenCalled();
    expect(entryA.scm.mergePr).not.toHaveBeenCalled();
  });

  it('routes push by the explicit repo argument', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm } = createProjectScopedPorts([entryA, entryB]);

    await scm.push('owner/repo-a', '/workspace', 'branch', 'hash');

    expect(entryA.scm.push).toHaveBeenCalledWith('owner/repo-a', '/workspace', 'branch', 'hash');
    expect(entryB.scm.push).not.toHaveBeenCalled();
  });

  it('routes readFile by the explicit repo argument', async () => {
    const entryA = buildEntry('owner/repo-a');
    const { scm } = createProjectScopedPorts([entryA]);

    await scm.readFile('owner/repo-a', 'agentops.json');

    expect(entryA.scm.readFile).toHaveBeenCalledWith('owner/repo-a', 'agentops.json');
  });

  it('resolveGit returns the git runner for the matching repo', () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { resolveGit } = createProjectScopedPorts([entryA, entryB]);

    expect(resolveGit('owner/repo-b')).toBe(entryB.git);
  });

  it('throws a clear error for a repo not in the registry', async () => {
    const { scm } = createProjectScopedPorts([buildEntry('owner/repo-a')]);

    await expect(scm.readFile('owner/unknown-repo', 'x.json')).rejects.toThrow(
      /no project registered for repo "owner\/unknown-repo"/,
    );
  });

  it('routes tracker calls with a linear-shaped ref by team key, not repo', async () => {
    const githubEntry = buildEntry('owner/repo-a');
    const linearEntry = buildEntry('owner/repo-linear', 'ENG');
    const { tracker } = createProjectScopedPorts([githubEntry, linearEntry]);

    await tracker.getIssue('linear:ENG-123');
    await tracker.comment('linear:ENG-123', 'hello');
    await tracker.label('linear:ENG-123', 'bug');

    expect(linearEntry.tracker.getIssue).toHaveBeenCalledWith('linear:ENG-123');
    expect(linearEntry.tracker.comment).toHaveBeenCalledWith('linear:ENG-123', 'hello');
    expect(linearEntry.tracker.label).toHaveBeenCalledWith('linear:ENG-123', 'bug');
    expect(githubEntry.tracker.getIssue).not.toHaveBeenCalled();
  });

  it('throws a clear error for a linear team key not in the registry', async () => {
    const { tracker } = createProjectScopedPorts([buildEntry('owner/repo-a')]);

    await expect(tracker.getIssue('linear:ENG-123')).rejects.toThrow(
      /no project registered for Linear team "ENG"/,
    );
  });
});
