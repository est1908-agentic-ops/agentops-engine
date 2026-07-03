# GitHub Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real `TrackerPort`/`ScmPort` implementations against the GitHub REST + GraphQL APIs, so `DevCycle` can operate against a real issue/PR instead of `MemoryTrackerPort`/`MemoryScmPort`.

**Architecture:** `GithubTrackerPort` and `GithubScmPort` each take a small `GithubClient` interface (the narrow subset of Octokit's REST + GraphQL surface actually used) via constructor injection — tests supply a hand-built fake, no network, no token. `GithubScmPort.push` uses the `GitCommandRunner` interface the worktree-activities plan already defined in `packages/ports` (not a new abstraction). PR feedback's `unresolvedThreads` requires a GraphQL call — GitHub's REST API has no thread-resolution field.

**Tech Stack:** TypeScript strict, `octokit` (new dependency), vitest.

**Prerequisite:** [worktree-activities plan](2026-07-03-worktree-activities.md) must be merged first — `push`'s signature (`workspaceRef` first) and the `GitCommandRunner` interface both come from it.

**Design doc:** [docs/superpowers/specs/2026-07-03-github-ports-design.md](../specs/2026-07-03-github-ports-design.md)

**Honesty note:** the `GithubClient` interface below is a best-effort shape based on Octokit's documented REST/GraphQL surface, sized to exactly what these two classes call. A real `Octokit` instance should satisfy it structurally, but wiring one in for a live run (deferred to the shared M1 integration step, same as every other sub-project) may need small adjustments — verify with `pnpm --filter @agentops/ports run typecheck` against a real `new Octokit(...)` at that point. Nothing in this plan's tests depends on that being exactly right, since they all inject the fake.

---

### Task 1: Add the `octokit` dependency

**Files:**
- Modify: `packages/ports/package.json`

- [ ] **Step 1: Add the dependency**

```json
{
  "name": "@agentops/ports",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*",
    "octokit": "^4.1.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` updates, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ports/package.json pnpm-lock.yaml
git commit -m "chore(ports): add octokit dependency"
```

---

### Task 2: Ref-parsing helpers

**Files:**
- Create: `packages/ports/src/github/parse-ref.ts`
- Test: `packages/ports/src/github/parse-ref.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ports/src/github/parse-ref.test.ts
import { describe, expect, it } from 'vitest';
import { parseRef, parseRepoSlug } from './parse-ref';

describe('parseRef', () => {
  it('parses "owner/repo#123"', () => {
    expect(parseRef('octocat/hello-world#42')).toEqual({ owner: 'octocat', repo: 'hello-world', number: 42 });
  });

  it('throws a clear error on malformed input', () => {
    expect(() => parseRef('not-a-ref')).toThrow(/expected "owner\/repo#number"/);
    expect(() => parseRef('owner/repo')).toThrow();
    expect(() => parseRef('owner/repo#not-a-number')).toThrow();
  });
});

describe('parseRepoSlug', () => {
  it('parses "owner/repo"', () => {
    expect(parseRepoSlug('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });

  it('throws a clear error on malformed input', () => {
    expect(() => parseRepoSlug('octocat/hello-world#42')).toThrow(/expected "owner\/repo"/);
    expect(() => parseRepoSlug('just-a-name')).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/ports/src/github/parse-ref.test.ts`
Expected: FAIL — `Cannot find module './parse-ref'`.

- [ ] **Step 3: Implement**

```ts
// packages/ports/src/github/parse-ref.ts
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

export interface ParsedRepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(repo: string): ParsedRepoSlug {
  const match = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!match) {
    throw new Error(`parseRepoSlug: expected "owner/repo", got "${repo}"`);
  }
  return { owner: match[1], repo: match[2] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/ports/src/github/parse-ref.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ports/src/github/parse-ref.ts packages/ports/src/github/parse-ref.test.ts
git commit -m "feat(ports): add owner/repo(#number) ref-parsing helpers"
```

---

### Task 3: `GithubClient` interface + `GithubTrackerPort`

**Files:**
- Create: `packages/ports/src/github/github-client.ts`
- Create: `packages/ports/src/github/github-tracker-port.ts`
- Test: `packages/ports/src/github/github-tracker-port.test.ts`

- [ ] **Step 1: Define the client interface**

```ts
// packages/ports/src/github/github-client.ts
export interface GithubIssueData {
  title: string;
  body: string | null;
  labels: Array<string | { name?: string }>;
}

export interface GithubClient {
  rest: {
    issues: {
      get(params: { owner: string; repo: string; issue_number: number }): Promise<{ data: GithubIssueData }>;
      createComment(params: { owner: string; repo: string; issue_number: number; body: string }): Promise<unknown>;
      addLabels(params: { owner: string; repo: string; issue_number: number; labels: string[] }): Promise<unknown>;
    };
    pulls: {
      create(params: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        title: string;
        body: string;
      }): Promise<{ data: { number: number; html_url: string } }>;
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{ data: { head: { sha: string } } }>;
    };
    repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: { default_branch: string } }>;
      getContent(params: { owner: string; repo: string; path: string }): Promise<{ data: { content?: string } }>;
    };
    checks: {
      listForRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: { check_runs: Array<{ status: string; conclusion: string | null }> } }>;
    };
  };
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// packages/ports/src/github/github-tracker-port.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { GithubClient } from './github-client';
import { GithubTrackerPort } from './github-tracker-port';

function fakeClient(overrides: Partial<GithubClient['rest']> = {}): GithubClient {
  return {
    rest: {
      issues: {
        get: vi.fn(),
        createComment: vi.fn(),
        addLabels: vi.fn(),
        ...overrides.issues,
      },
      pulls: { create: vi.fn(), get: vi.fn(), ...overrides.pulls },
      repos: { get: vi.fn(), getContent: vi.fn(), ...overrides.repos },
      checks: { listForRef: vi.fn(), ...overrides.checks },
    },
    graphql: vi.fn(),
  } as unknown as GithubClient;
}

describe('GithubTrackerPort', () => {
  it('getIssue fetches and maps to the Issue shape', async () => {
    const client = fakeClient({
      issues: {
        get: vi.fn().mockResolvedValue({
          data: { title: 'Bug', body: 'It is broken', labels: ['bug', { name: 'p1' }] },
        }),
      } as never,
    });
    const tracker = new GithubTrackerPort(client);

    const issue = await tracker.getIssue('octocat/hello-world#42');

    expect(issue).toEqual({ ref: 'octocat/hello-world#42', title: 'Bug', body: 'It is broken', labels: ['bug', 'p1'] });
    expect(client.rest.issues.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world', issue_number: 42 });
  });

  it('getIssue defaults a null body to an empty string', async () => {
    const client = fakeClient({
      issues: { get: vi.fn().mockResolvedValue({ data: { title: 'T', body: null, labels: [] } }) } as never,
    });
    const tracker = new GithubTrackerPort(client);

    const issue = await tracker.getIssue('o/r#1');

    expect(issue.body).toBe('');
  });

  it('comment posts to the issue comments endpoint', async () => {
    const client = fakeClient();
    const tracker = new GithubTrackerPort(client);

    await tracker.comment('octocat/hello-world#42', 'hello');

    expect(client.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      issue_number: 42,
      body: 'hello',
    });
  });

  it('label adds the label', async () => {
    const client = fakeClient();
    const tracker = new GithubTrackerPort(client);

    await tracker.label('octocat/hello-world#42', 'bug');

    expect(client.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      issue_number: 42,
      labels: ['bug'],
    });
  });

  it('throws a clear error on a malformed ref before ever calling the client', async () => {
    const client = fakeClient();
    const tracker = new GithubTrackerPort(client);

    await expect(tracker.getIssue('not-a-ref')).rejects.toThrow(/expected "owner\/repo#number"/);
    expect(client.rest.issues.get).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/ports/src/github/github-tracker-port.test.ts`
Expected: FAIL — `Cannot find module './github-tracker-port'`.

- [ ] **Step 4: Implement**

```ts
// packages/ports/src/github/github-tracker-port.ts
import type { Issue, TrackerPort } from '../tracker-port';
import type { GithubClient } from './github-client';
import { parseRef } from './parse-ref';

export class GithubTrackerPort implements TrackerPort {
  constructor(private readonly client: GithubClient) {}

  async getIssue(ref: string): Promise<Issue> {
    const { owner, repo, number } = parseRef(ref);
    const { data } = await this.client.rest.issues.get({ owner, repo, issue_number: number });
    return {
      ref,
      title: data.title,
      body: data.body ?? '',
      labels: data.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    };
  }

  async comment(ref: string, body: string): Promise<void> {
    const { owner, repo, number } = parseRef(ref);
    await this.client.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }

  async label(ref: string, label: string): Promise<void> {
    const { owner, repo, number } = parseRef(ref);
    await this.client.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [label] });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/ports/src/github/github-tracker-port.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ports/src/github/github-client.ts packages/ports/src/github/github-tracker-port.ts packages/ports/src/github/github-tracker-port.test.ts
git commit -m "feat(ports): add GithubTrackerPort"
```

---

### Task 4: `GithubScmPort` — `openPr` and `readFile`

**Files:**
- Create: `packages/ports/src/github/github-scm-port.ts`
- Test: `packages/ports/src/github/github-scm-port.test.ts`

Split across two tasks (this one and Task 5) since `getPrFeedback` is the highest-risk piece and deserves to be tested in isolation, per the design doc's call-out.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ports/src/github/github-scm-port.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { GithubClient } from './github-client';
import { GithubScmPort } from './github-scm-port';

function fakeClient(): GithubClient {
  return {
    rest: {
      issues: { get: vi.fn(), createComment: vi.fn(), addLabels: vi.fn() },
      pulls: { create: vi.fn(), get: vi.fn() },
      repos: { get: vi.fn(), getContent: vi.fn() },
      checks: { listForRef: vi.fn() },
    },
    graphql: vi.fn(),
  } as unknown as GithubClient;
}

function fakeGit(): { git: GitCommandRunner; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    git: {
      run: vi.fn(async (args: string[], opts: { cwd: string }) => {
        calls.push({ args, cwd: opts.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    },
    calls,
  };
}

describe('GithubScmPort — openPr', () => {
  it('fetches the default branch and opens a PR against it', async () => {
    const client = fakeClient();
    (client.rest.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { default_branch: 'main' } });
    (client.rest.pulls.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { number: 7, html_url: 'https://github.com/octocat/hello-world/pull/7' },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    const result = await scm.openPr({ repo: 'octocat/hello-world', branch: 'agentops/t1', title: 'T', body: 'B' });

    expect(client.rest.repos.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world' });
    expect(client.rest.pulls.create).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      head: 'agentops/t1',
      base: 'main',
      title: 'T',
      body: 'B',
    });
    expect(result).toEqual({ prRef: 'octocat/hello-world#7', url: 'https://github.com/octocat/hello-world/pull/7' });
  });
});

describe('GithubScmPort — readFile', () => {
  it('decodes base64 content', async () => {
    const client = fakeClient();
    (client.rest.repos.getContent as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { content: Buffer.from('# demo').toString('base64') },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    const content = await scm.readFile('octocat/hello-world', 'README.md');

    expect(client.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'README.md',
    });
    expect(content).toBe('# demo');
  });

  it('returns null on a 404', async () => {
    const client = fakeClient();
    (client.rest.repos.getContent as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(scm.readFile('octocat/hello-world', 'nope.json')).resolves.toBeNull();
  });

  it('rethrows on a non-404 error', async () => {
    const client = fakeClient();
    (client.rest.repos.getContent as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 500 });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(scm.readFile('octocat/hello-world', 'x.json')).rejects.toMatchObject({ status: 500 });
  });
});

describe('GithubScmPort — push', () => {
  it('runs git push origin <branch> in the given workspace, with no token handling here', async () => {
    const client = fakeClient();
    const { git, calls } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await scm.push('/tmp/workspace', 'agentops/t1', 'hash-1');

    expect(calls).toEqual([{ args: ['push', 'origin', 'agentops/t1'], cwd: '/tmp/workspace' }]);
  });

  it('throws if the push fails', async () => {
    const client = fakeClient();
    const git: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: '', stderr: 'rejected', exitCode: 1 }) };
    const scm = new GithubScmPort(client, git);

    await expect(scm.push('/tmp/workspace', 'agentops/t1', 'hash-1')).rejects.toThrow(/rejected/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/ports/src/github/github-scm-port.test.ts`
Expected: FAIL — `Cannot find module './github-scm-port'`.

- [ ] **Step 3: Implement `openPr`, `push`, `readFile` (leave `getPrFeedback` as a stub throwing "not implemented" for now — Task 5 fills it in)**

```ts
// packages/ports/src/github/github-scm-port.ts
import type { PrFeedback } from '@agentops/contracts';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { OpenPrRequest, OpenPrResult, ScmPort } from '../scm-port';
import type { GithubClient } from './github-client';
import { parseRef, parseRepoSlug } from './parse-ref';

export class GithubScmPort implements ScmPort {
  constructor(
    private readonly client: GithubClient,
    private readonly git: GitCommandRunner,
  ) {}

  async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
    const { owner, repo } = parseRepoSlug(req.repo);
    const { data: repoData } = await this.client.rest.repos.get({ owner, repo });
    const { data: prData } = await this.client.rest.pulls.create({
      owner,
      repo,
      head: req.branch,
      base: repoData.default_branch,
      title: req.title,
      body: req.body,
    });
    return { prRef: `${owner}/${repo}#${prData.number}`, url: prData.html_url };
  }

  async getPrFeedback(_prRef: string): Promise<PrFeedback> {
    throw new Error('GithubScmPort.getPrFeedback: not implemented yet (see Task 5)');
  }

  async push(workspaceRef: string, branch: string, _contentHash: string): Promise<void> {
    const result = await this.git.run(['push', 'origin', branch], { cwd: workspaceRef });
    if (result.exitCode !== 0) {
      throw new Error(`GithubScmPort.push: git push failed: ${result.stderr}`);
    }
  }

  async readFile(repo: string, path: string): Promise<string | null> {
    const { owner, repo: repoName } = parseRepoSlug(repo);
    try {
      const { data } = await this.client.rest.repos.getContent({ owner, repo: repoName, path });
      return data.content ? Buffer.from(data.content, 'base64').toString('utf8') : null;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/ports/src/github/github-scm-port.test.ts`
Expected: PASS (6 tests) — the `getPrFeedback`-related tests don't exist yet, so nothing exercises the stub.

- [ ] **Step 5: Commit**

```bash
git add packages/ports/src/github/github-scm-port.ts packages/ports/src/github/github-scm-port.test.ts
git commit -m "feat(ports): add GithubScmPort openPr/push/readFile"
```

---

### Task 5: `GithubScmPort.getPrFeedback` — checks API + GraphQL review threads

**Files:**
- Modify: `packages/ports/src/github/github-scm-port.ts`
- Modify: `packages/ports/src/github/github-scm-port.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/ports/src/github/github-scm-port.test.ts`:

```ts
describe('GithubScmPort — getPrFeedback', () => {
  function setupPrFeedback(overrides: {
    checkRuns?: Array<{ status: string; conclusion: string | null }>;
    reviewThreads?: Array<{ isResolved: boolean; comments: { nodes: Array<{ id: string; body: string }> } }>;
  }) {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'abc123' } } });
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { check_runs: overrides.checkRuns ?? [] },
    });
    (client.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: overrides.reviewThreads ?? [] } } },
    });
    const { git } = fakeGit();
    return new GithubScmPort(client, git);
  }

  it('maps all-completed, all-success check runs to green', async () => {
    const scm = setupPrFeedback({
      checkRuns: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('green');
  });

  it('maps any incomplete check run to pending', async () => {
    const scm = setupPrFeedback({
      checkRuns: [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('pending');
  });

  it('maps a completed-but-failed check run to failed', async () => {
    const scm = setupPrFeedback({
      checkRuns: [{ status: 'completed', conclusion: 'failure' }],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('failed');
  });

  it('maps zero check runs to pending, not a vacuous green', async () => {
    const scm = setupPrFeedback({ checkRuns: [] });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('pending');
  });

  it('counts unresolved review threads via GraphQL, not REST', async () => {
    const scm = setupPrFeedback({
      checkRuns: [{ status: 'completed', conclusion: 'success' }],
      reviewThreads: [
        { isResolved: false, comments: { nodes: [{ id: 'c1', body: 'fix this' }] } },
        { isResolved: true, comments: { nodes: [{ id: 'c2', body: 'looks good now' }] } },
      ],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.unresolvedThreads).toBe(1);
    expect(feedback.comments).toEqual([
      { id: 'c1', body: 'fix this', resolved: false },
      { id: 'c2', body: 'looks good now', resolved: true },
    ]);
  });

  it('fetches the PR head SHA before querying checks', async () => {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'sha-xyz' } } });
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { check_runs: [] } });
    (client.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await scm.getPrFeedback('octocat/hello-world#7');

    expect(client.rest.pulls.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world', pull_number: 7 });
    expect(client.rest.checks.listForRef).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      ref: 'sha-xyz',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/ports/src/github/github-scm-port.test.ts`
Expected: FAIL — the stub throws `not implemented yet`.

- [ ] **Step 3: Implement**

Replace the `getPrFeedback` stub in `packages/ports/src/github/github-scm-port.ts`:

```ts
  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    const { owner, repo, number } = parseRef(prRef);
    const { data: pr } = await this.client.rest.pulls.get({ owner, repo, pull_number: number });
    const { data: checksData } = await this.client.rest.checks.listForRef({ owner, repo, ref: pr.head.sha });
    const ciStatus = mapCiStatus(checksData.check_runs);

    const graphqlResult = await this.client.graphql<GraphqlReviewThreadsResult>(REVIEW_THREADS_QUERY, {
      owner,
      repo,
      number,
    });
    const threads = graphqlResult.repository.pullRequest.reviewThreads.nodes;
    const unresolvedThreads = threads.filter((thread) => !thread.isResolved).length;
    const comments = threads.map((thread) => ({
      id: thread.comments.nodes[0]?.id ?? '',
      body: thread.comments.nodes[0]?.body ?? '',
      resolved: thread.isResolved,
    }));

    return { ciStatus, unresolvedThreads, comments };
  }
```

Add the supporting types/constants/function above the class (or in the same file, below the imports):

```ts
interface GraphqlReviewThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ id: string; body: string }> } }>;
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { isResolved comments(first: 1) { nodes { id body } } }
        }
      }
    }
  }
`;

function mapCiStatus(checkRuns: Array<{ status: string; conclusion: string | null }>): 'pending' | 'green' | 'failed' {
  if (checkRuns.length === 0 || checkRuns.some((run) => run.status !== 'completed')) {
    return 'pending';
  }
  return checkRuns.every((run) => run.conclusion === 'success') ? 'green' : 'failed';
}
```

(`PrFeedback`'s `ciStatus` field is typed `CiStatus` in `@agentops/contracts` — `mapCiStatus`'s return type matches it structurally; import `CiStatus` from `@agentops/contracts` instead of inlining the union if you'd rather have a named type. Either compiles.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/ports/src/github/github-scm-port.test.ts`
Expected: PASS (all 12 tests across both `describe` blocks added in Tasks 4 and 5).

- [ ] **Step 5: Commit**

```bash
git add packages/ports/src/github/github-scm-port.ts packages/ports/src/github/github-scm-port.test.ts
git commit -m "feat(ports): implement GithubScmPort.getPrFeedback (checks API + GraphQL review threads)"
```

---

### Task 6: Export from the package barrel

**Files:**
- Modify: `packages/ports/src/index.ts`

- [ ] **Step 1: Update the barrel**

```ts
export * from './tracker-port';
export * from './scm-port';
export * from './memory/memory-tracker';
export * from './memory/memory-scm';
export * from './git/git-command-runner';
export * from './github/parse-ref';
export * from './github/github-client';
export * from './github/github-tracker-port';
export * from './github/github-scm-port';
```

- [ ] **Step 2: Typecheck the whole package**

Run: `pnpm --filter @agentops/ports run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ports/src/index.ts
git commit -m "feat(ports): export GitHub adapters from the package barrel"
```

---

### Task 7: Full local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

Expected: all green. `pnpm e2e` isn't expected to exercise the GitHub adapters at all (still `MemoryTrackerPort`/`MemoryScmPort` there) — this run confirms nothing else regressed.

- [ ] **Step 2: Commit if the gate required any fixes**

```bash
git add -A
git commit -m "chore: fix lint/typecheck fallout from GitHub ports"
```

(Skip if Step 1 was already green.)

---

### Task 8: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: real GitHub TrackerPort/ScmPort adapters"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
