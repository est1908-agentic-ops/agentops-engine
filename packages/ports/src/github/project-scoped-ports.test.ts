import { describe, expect, it, vi } from 'vitest';
import type { PrFeedback } from '@agentops/contracts';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { ScmPort } from '../scm-port';
import type { TrackerPort } from '../tracker-port';
import { createProjectScopedPorts, type ProjectScopedPortsEntry } from './project-scoped-ports';

function fakeScm(): ScmPort {
  return {
    openPr: vi.fn().mockResolvedValue({ prRef: 'r#1', url: 'https://x' }),
    getPrFeedback: vi.fn().mockResolvedValue({ ciStatus: 'green', unresolvedThreads: 0, comments: [] } satisfies PrFeedback),
    push: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('content'),
  };
}

function fakeTracker(): TrackerPort {
  return {
    getIssue: vi.fn().mockResolvedValue({ ref: 'r#1', title: 'T', body: 'B', labels: [] }),
    comment: vi.fn().mockResolvedValue(undefined),
    label: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeGit(): GitCommandRunner {
  return { run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) };
}

function buildEntry(repo: string): ProjectScopedPortsEntry {
  return { repo, scm: fakeScm(), tracker: fakeTracker(), git: fakeGit() };
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
});
