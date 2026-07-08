# Platform Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/control` (a Node HTTP BFF) and `packages/ui` (a Vite+React SPA) that let an operator start and watch `platform` Temporal workflow runs from a browser, replacing the need to use Temporal's native "Start Workflow" form.

**Architecture:** `control` talks to Temporal via `@temporalio/client` (same SDK `packages/cli`/`packages/gateway` already use) behind 5 plain `node:http` routes, validated at the boundary with new `@agentops/contracts` zod schemas, and serves `ui`'s built static assets in production. `ui` is a 2-route React SPA (home + run detail) that polls the detail endpoint while a run is `RUNNING`. Full design: `docs/superpowers/specs/2026-07-07-platform-console-design.md`.

**Tech Stack:** TypeScript, `@temporalio/client`, zod, vitest, Vite, React, react-router-dom, Helm, pnpm workspaces.

---

## Task 1: Add `control-api` contracts

**Files:**
- Create: `packages/contracts/src/control-api.ts`
- Create: `packages/contracts/src/control-api.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/control-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from './control-api';

describe('StartRunRequestSchema', () => {
  it('requires a non-empty prompt', () => {
    expect(() => StartRunRequestSchema.parse({ prompt: '' })).toThrow();
  });

  it('allows hintRepos and workflowId to be omitted', () => {
    const parsed = StartRunRequestSchema.parse({ prompt: 'check the last failures' });
    expect(parsed.hintRepos).toBeUndefined();
    expect(parsed.workflowId).toBeUndefined();
  });

  it('accepts hintRepos and a caller-supplied workflowId', () => {
    const parsed = StartRunRequestSchema.parse({
      prompt: 'check the last failures',
      hintRepos: ['flair-hr/agentops-engine'],
      workflowId: 'platform-my-run',
    });
    expect(parsed.hintRepos).toEqual(['flair-hr/agentops-engine']);
    expect(parsed.workflowId).toBe('platform-my-run');
  });
});

describe('StartRunResponseSchema', () => {
  it('requires workflowId and runId', () => {
    expect(() => StartRunResponseSchema.parse({ workflowId: 'w1' })).toThrow();
    expect(StartRunResponseSchema.parse({ workflowId: 'w1', runId: 'r1' })).toEqual({
      workflowId: 'w1',
      runId: 'r1',
    });
  });
});

describe('RunListItemSchema', () => {
  it('accepts a running item with no closeTime/promptSnippet', () => {
    const parsed = RunListItemSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'RUNNING',
      startTime: '2026-07-07T00:00:00.000Z',
    });
    expect(parsed.closeTime).toBeUndefined();
    expect(parsed.promptSnippet).toBeUndefined();
  });

  it('rejects an unrecognized status', () => {
    expect(() =>
      RunListItemSchema.parse({
        workflowId: 'platform-1',
        runId: 'r1',
        status: 'BOGUS',
        startTime: '2026-07-07T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('accepts the full set of realistic terminal statuses', () => {
    for (const status of ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW']) {
      expect(() =>
        RunListItemSchema.parse({ workflowId: 'w', runId: 'r', status, startTime: '2026-07-07T00:00:00.000Z' }),
      ).not.toThrow();
    }
  });
});

describe('RunDetailSchema', () => {
  it('accepts a running detail with no result/error', () => {
    const parsed = RunDetailSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'RUNNING',
      temporalUrl: 'https://temporal.example/namespaces/default/workflows/platform-1/r1/history',
    });
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });

  it('accepts a completed detail with a result', () => {
    const parsed = RunDetailSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'COMPLETED',
      temporalUrl: 'https://temporal.example/namespaces/default/workflows/platform-1/r1/history',
      result: { summary: 'all quiet', actionsTaken: [], childWorkflows: [] },
    });
    expect(parsed.result?.summary).toBe('all quiet');
  });

  it('accepts a failed detail with an error and no result', () => {
    const parsed = RunDetailSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'FAILED',
      temporalUrl: 'https://temporal.example/namespaces/default/workflows/platform-1/r1/history',
      error: 'workflow ended with status FAILED',
    });
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBe('workflow ended with status FAILED');
  });
});

describe('RepoListResponseSchema', () => {
  it('accepts an empty repo list', () => {
    expect(RepoListResponseSchema.parse({ repos: [] })).toEqual({ repos: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/contracts/src/control-api.test.ts`
Expected: FAIL — cannot find module `./control-api`.

- [ ] **Step 3: Write the schemas**

Create `packages/contracts/src/control-api.ts`:

```ts
import { z } from 'zod';
import { PlatformAgentResultSchema } from './platform-agent';

export const StartRunRequestSchema = z.object({
  prompt: z.string().min(1),
  hintRepos: z.array(z.string()).optional(),
  workflowId: z.string().min(1).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
});
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

// Matches @temporalio/client's WorkflowExecutionStatusName, minus the values
// ('UNSPECIFIED' | 'PAUSED' | 'UNKNOWN') that don't apply to a Workflow
// Execution that has actually started and been fetched.
export const RunStatusSchema = z.enum([
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
  'CONTINUED_AS_NEW',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunListItemSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  startTime: z.string().min(1),
  closeTime: z.string().min(1).optional(),
  // Truncated prompt text from the Temporal memo set at start -- NOT
  // PlatformAgentResult.summary, which only exists once a run completes.
  promptSnippet: z.string().min(1).optional(),
});
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunDetailSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  prompt: z.string().min(1).optional(),
  result: PlatformAgentResultSchema.optional(),
  error: z.string().min(1).optional(),
  temporalUrl: z.string().min(1),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RepoListResponseSchema = z.object({
  repos: z.array(z.string()),
});
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;
```

- [ ] **Step 4: Export from the package index**

In `packages/contracts/src/index.ts`, add:

```ts
export * from './control-api';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- packages/contracts/src/control-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/control-api.ts packages/contracts/src/control-api.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add platform console API schemas"
```

---

## Task 2: Scaffold `packages/control` and its path-matching helper

**Files:**
- Create: `packages/control/package.json`
- Create: `packages/control/tsconfig.json`
- Create: `packages/control/src/route.ts`
- Create: `packages/control/src/route.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/control/package.json`:

```json
{
  "name": "@agentops/control",
  "version": "0.0.0",
  "private": true,
  "main": "src/main.ts",
  "types": "src/main.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@agentops/activities": "workspace:*",
    "@agentops/contracts": "workspace:*",
    "@agentops/workflows": "workspace:*",
    "@temporalio/client": "^1.11.0"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

Create `packages/control/tsconfig.json` (identical shape to `packages/gateway/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test for the route matcher**

Create `packages/control/src/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchPath } from './route';

describe('matchPath', () => {
  it('matches an exact literal path with no params', () => {
    expect(matchPath('/healthz', '/healthz')).toEqual({ params: {} });
  });

  it('returns null for a literal path that does not match', () => {
    expect(matchPath('/healthz', '/nope')).toBeNull();
  });

  it('extracts a single path param', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/platform-1')).toEqual({
      params: { workflowId: 'platform-1' },
    });
  });

  it('returns null when segment counts differ', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs')).toBeNull();
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/a/b')).toBeNull();
  });

  it('returns null when a literal segment does not match, even with a param present', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/other/runs/platform-1')).toBeNull();
  });

  it('URL-decodes the param value', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/platform%2F1')).toEqual({
      params: { workflowId: 'platform/1' },
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- packages/control/src/route.test.ts`
Expected: FAIL — cannot find module `./route`. (This works even before `pnpm install` wires the workspace package, since vitest's root config resolves `packages/*/src/**/*.test.ts` directly — see Step 6.)

- [ ] **Step 5: Write the matcher**

Create `packages/control/src/route.ts`:

```ts
export interface MatchedRoute {
  params: Record<string, string>;
}

export function matchPath(pattern: string, path: string): MatchedRoute | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);

  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(pathSegment);
    } else if (segment !== pathSegment) {
      return null;
    }
  }

  return { params };
}
```

- [ ] **Step 6: Install the new workspace package, then run the test**

```bash
pnpm install
pnpm test -- packages/control/src/route.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/control/package.json packages/control/tsconfig.json packages/control/src/route.ts packages/control/src/route.test.ts pnpm-lock.yaml
git commit -m "feat(control): scaffold the control BFF package and its path matcher"
```

---

## Task 3: Add `readRegistryRepos`

**Why:** `control` needs the registered repo slugs for the hint-repos picker, but must not require the GitHub write tokens `loadProjectRegistry` (from `@agentops/activities`) demands — `control` never authenticates to any repo, it only lists names. This is a separate, token-free reader over the same `PROJECT_REGISTRY_JSON` env var.

**Files:**
- Create: `packages/control/src/read-registry-repos.ts`
- Create: `packages/control/src/read-registry-repos.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/control/src/read-registry-repos.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readRegistryRepos } from './read-registry-repos';

describe('readRegistryRepos', () => {
  it('returns an empty array when PROJECT_REGISTRY_JSON is unset', () => {
    expect(readRegistryRepos({})).toEqual([]);
  });

  it('returns repo slugs without requiring any token env vars to be set', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
      ]),
    };

    expect(readRegistryRepos(env)).toEqual(['flair-hr/product-a']);
  });

  it('returns multiple repo slugs in registry order', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'X' },
        { product: 'product-b', repo: 'flair-hr/product-b', trackerType: 'github', tokenEnvVar: 'Y' },
      ]),
    };

    expect(readRegistryRepos(env)).toEqual(['flair-hr/product-a', 'flair-hr/product-b']);
  });

  it('throws on a malformed PROJECT_REGISTRY_JSON', () => {
    expect(() => readRegistryRepos({ PROJECT_REGISTRY_JSON: '{}' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/control/src/read-registry-repos.test.ts`
Expected: FAIL — cannot find module `./read-registry-repos`.

- [ ] **Step 3: Write the reader**

Create `packages/control/src/read-registry-repos.ts`:

```ts
import { parseProjectRegistry } from '@agentops/contracts';

/**
 * Repo slugs for the hint-repos picker, read directly from
 * PROJECT_REGISTRY_JSON. Deliberately does not resolve tokens the way
 * @agentops/activities' loadProjectRegistry does -- control only needs repo
 * names for a picker, never a credential, so it must not require every
 * registered repo's token env var to be set just to boot.
 */
export function readRegistryRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) {
    return [];
  }
  const registry = parseProjectRegistry(JSON.parse(raw));
  return registry.map((entry) => entry.repo);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/control/src/read-registry-repos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/read-registry-repos.ts packages/control/src/read-registry-repos.test.ts
git commit -m "feat(control): add a token-free registry repo reader"
```

---

## Task 4: Add `resolveStaticFile` for serving the built SPA

**Files:**
- Create: `packages/control/src/serve-static.ts`
- Create: `packages/control/src/serve-static.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/control/src/serve-static.test.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStaticFile } from './serve-static';

describe('resolveStaticFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'control-static-'));
    await writeFile(join(root, 'index.html'), '<html>home</html>');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves index.html for the root path', async () => {
    const file = await resolveStaticFile(root, '/');
    expect(file?.contentType).toBe('text/html; charset=utf-8');
    expect(file?.body.toString('utf8')).toBe('<html>home</html>');
  });

  it('serves a real asset by its exact path', async () => {
    const file = await resolveStaticFile(root, '/assets/app.js');
    expect(file?.contentType).toBe('text/javascript; charset=utf-8');
    expect(file?.body.toString('utf8')).toBe('console.log(1)');
  });

  it('falls back to index.html for an extension-less client-side route', async () => {
    const file = await resolveStaticFile(root, '/runs/platform-1');
    expect(file?.body.toString('utf8')).toBe('<html>home</html>');
  });

  it('returns null for a missing asset that has an extension', async () => {
    expect(await resolveStaticFile(root, '/assets/missing.js')).toBeNull();
  });

  it('returns null for a path-traversal attempt instead of escaping rootDir', async () => {
    await writeFile(join(tmpdir(), 'secret.txt'), 'do not serve me');
    expect(await resolveStaticFile(root, '/../secret.txt')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/control/src/serve-static.test.ts`
Expected: FAIL — cannot find module `./serve-static`.

- [ ] **Step 3: Write the implementation**

Create `packages/control/src/serve-static.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  contentType: string;
  body: Buffer;
}

/**
 * Resolves a URL path to a file under rootDir, falling back to index.html
 * for any path with no recognized extension -- client-side routes like
 * /runs/:workflowId have no matching file on disk and must still serve the
 * SPA shell. Returns null if nothing resolves; the caller responds 404.
 */
export async function resolveStaticFile(rootDir: string, urlPath: string): Promise<StaticFile | null> {
  const resolvedRoot = resolve(rootDir);
  const hasExtension = extname(urlPath) !== '';
  const relativePath = urlPath === '/' || !hasExtension ? 'index.html' : urlPath;
  const filePath = resolve(join(resolvedRoot, relativePath));

  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}/`)) {
    return null;
  }

  try {
    const body = await readFile(filePath);
    const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    return { contentType, body };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/control/src/serve-static.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/serve-static.ts packages/control/src/serve-static.test.ts
git commit -m "feat(control): add static file serving for the built SPA"
```

---

## Task 5: Implement `createControlServer` (all 5 routes)

**Files:**
- Create: `packages/control/src/create-control-server.ts`
- Create: `packages/control/src/create-control-server.test.ts`

This is the core of the BFF. Tests exercise the real HTTP surface (server bound to an ephemeral port, requests made with `fetch`), mirroring `packages/gateway/src/create-gateway-server.test.ts` exactly, with a fake `Client` object standing in for `@temporalio/client`.

- [ ] **Step 1: Write the failing tests**

Create `packages/control/src/create-control-server.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlServer, type ControlDeps } from './create-control-server';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'platform-1',
    runId: 'run-1',
    status: { code: 1, name: 'RUNNING' },
    startTime: new Date('2026-07-07T00:00:00.000Z'),
    closeTime: undefined,
    memo: {},
    ...overrides,
  };
}

async function getJson(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('createControlServer', () => {
  let server: ReturnType<typeof createControlServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let getHandle: ReturnType<typeof vi.fn>;
  let deps: ControlDeps;

  function listen() {
    server = createControlServer(deps);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  beforeEach(() => {
    start = vi.fn().mockResolvedValue({ workflowId: 'platform-1', firstExecutionRunId: 'run-1' });
    list = vi.fn(async function* () {
      yield makeExecution();
    });
    getHandle = vi.fn();
    deps = {
      client: { workflow: { start, list, getHandle } } as never,
      taskQueue: 'agentops-devcycle',
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
      registry: ['flair-hr/agentops-engine', 'flair-hr/agentops-platform'],
    };
  });

  afterEach(() => {
    server?.close();
  });

  it('GET /healthz responds 200 without touching Temporal', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(start).not.toHaveBeenCalled();
  });

  describe('POST /api/platform/runs', () => {
    it('rejects an empty prompt with 400', async () => {
      await listen();
      const { status, body } = await postJson(port, '/api/platform/runs', { prompt: '' });
      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
      expect(start).not.toHaveBeenCalled();
    });

    it('starts the platform workflow with the correct taskQueue, args, and memo', async () => {
      await listen();
      const { status, body } = await postJson(port, '/api/platform/runs', {
        prompt: 'investigate the last failures',
        hintRepos: ['flair-hr/agentops-engine'],
      });

      expect(status).toBe(202);
      expect(body).toEqual({ workflowId: 'platform-1', runId: 'run-1' });
      expect(start).toHaveBeenCalledTimes(1);
      const [, options] = start.mock.calls[0];
      expect(options.taskQueue).toBe('agentops-devcycle');
      expect(options.args).toEqual([{ prompt: 'investigate the last failures', hintRepos: ['flair-hr/agentops-engine'] }]);
      expect(options.memo).toEqual({ prompt: 'investigate the last failures' });
      expect(typeof options.workflowId).toBe('string');
    });

    it('uses a caller-supplied workflowId when provided', async () => {
      await listen();
      await postJson(port, '/api/platform/runs', { prompt: 'x', workflowId: 'platform-my-run' });
      const [, options] = start.mock.calls[0];
      expect(options.workflowId).toBe('platform-my-run');
    });

    it('responds 409 when the workflowId is already in use', async () => {
      start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already started', 'platform-dup', 'platform'));
      await listen();
      const { status, body } = await postJson(port, '/api/platform/runs', { prompt: 'x', workflowId: 'platform-dup' });
      expect(status).toBe(409);
      expect(body.error).toBeTruthy();
    });
  });

  describe('GET /api/platform/runs', () => {
    it('maps visibility results into RunListItem shape, including promptSnippet from memo', async () => {
      list.mockImplementation(async function* () {
        yield makeExecution({ memo: { prompt: 'a'.repeat(150) } });
      });
      await listen();
      const { status, body } = await getJson(port, '/api/platform/runs');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].workflowId).toBe('platform-1');
      expect(body[0].promptSnippet.length).toBeLessThan(150);
    });

    it('respects the limit query param', async () => {
      list.mockImplementation(async function* () {
        yield makeExecution({ workflowId: 'platform-1' });
        yield makeExecution({ workflowId: 'platform-2' });
        yield makeExecution({ workflowId: 'platform-3' });
      });
      await listen();
      const { body } = await getJson(port, '/api/platform/runs?limit=2');
      expect(body).toHaveLength(2);
    });
  });

  describe('GET /api/platform/runs/:workflowId', () => {
    it('returns a parsed result for a completed run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({
          runId: 'run-1',
          status: { code: 2, name: 'COMPLETED' },
          memo: { prompt: 'investigate' },
        }),
        result: vi.fn().mockResolvedValue({ summary: 'all quiet', actionsTaken: [], childWorkflows: [] }),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/platform/runs/platform-1');
      expect(status).toBe(200);
      expect(body.status).toBe('COMPLETED');
      expect(body.prompt).toBe('investigate');
      expect(body.result.summary).toBe('all quiet');
      expect(body.error).toBeUndefined();
    });

    it('returns no result field for a running run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 1, name: 'RUNNING' }, memo: {} }),
        result: vi.fn(),
      });
      await listen();
      const { body } = await getJson(port, '/api/platform/runs/platform-1');
      expect(body.status).toBe('RUNNING');
      expect(body.result).toBeUndefined();
      expect(body.error).toBeUndefined();
    });

    it('responds 404 when describe() throws (unknown workflowId)', async () => {
      getHandle.mockReturnValue({ describe: vi.fn().mockRejectedValue(new Error('not found')), result: vi.fn() });
      await listen();
      const { status } = await getJson(port, '/api/platform/runs/does-not-exist');
      expect(status).toBe(404);
    });

    it('sets error (not a 500) when a completed run\'s output fails PlatformAgentResultSchema', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 2, name: 'COMPLETED' }, memo: {} }),
        result: vi.fn().mockResolvedValue({ nope: true }),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/platform/runs/platform-1');
      expect(status).toBe(200);
      expect(body.result).toBeUndefined();
      expect(body.error).toBeTruthy();
    });

    it('sets a status-based error for a terminal non-completed run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 3, name: 'FAILED' }, memo: {} }),
        result: vi.fn(),
      });
      await listen();
      const { body } = await getJson(port, '/api/platform/runs/platform-1');
      expect(body.status).toBe('FAILED');
      expect(body.error).toContain('FAILED');
    });
  });

  it('GET /api/registry/repos returns the configured registry', async () => {
    await listen();
    const { status, body } = await getJson(port, '/api/registry/repos');
    expect(status).toBe(200);
    expect(body).toEqual({ repos: ['flair-hr/agentops-engine', 'flair-hr/agentops-platform'] });
  });

  it('404s an unknown route with no uiDistPath configured', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  describe('static file fallback', () => {
    let uiDistPath: string;

    beforeEach(async () => {
      uiDistPath = await mkdtemp(join(tmpdir(), 'control-ui-dist-'));
      await writeFile(join(uiDistPath, 'index.html'), '<html>console</html>');
    });

    afterEach(async () => {
      await rm(uiDistPath, { recursive: true, force: true });
    });

    it('serves the built SPA shell when uiDistPath is configured', async () => {
      deps.uiDistPath = uiDistPath;
      await listen();
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('<html>console</html>');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- packages/control/src/create-control-server.test.ts`
Expected: FAIL — cannot find module `./create-control-server`.

- [ ] **Step 3: Write the implementation**

Create `packages/control/src/create-control-server.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import {
  PlatformAgentResultSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from '@agentops/contracts';
import { platform } from '@agentops/workflows';
import { matchPath } from './route';
import { resolveStaticFile } from './serve-static';

export interface ControlDeps {
  client: Client;
  taskQueue: string;
  namespace: string;
  temporalUiBaseUrl: string;
  registry: string[];
  uiDistPath?: string;
}

interface HandlerResponse {
  status: number;
  body?: unknown;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function memoPrompt(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.prompt === 'string' ? memo.prompt : undefined;
}

async function handleStartRun(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }

  const parsed = StartRunRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }

  const { prompt, hintRepos, workflowId: requestedWorkflowId } = parsed.data;
  const workflowId = requestedWorkflowId ?? `platform-${randomUUID()}`;

  try {
    const handle = await deps.client.workflow.start(platform, {
      taskQueue: deps.taskQueue,
      workflowId,
      args: [{ prompt, hintRepos }],
      memo: { prompt },
    });
    return {
      status: 202,
      body: StartRunResponseSchema.parse({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId }),
    };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { status: 409, body: { error: `a run with workflowId "${workflowId}" already exists` } };
    }
    throw err;
  }
}

async function handleListRuns(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20;

  const items: unknown[] = [];
  for await (const execution of deps.client.workflow.list({ query: 'WorkflowType="platform" ORDER BY StartTime DESC' })) {
    if (items.length >= limit) {
      break;
    }
    const prompt = memoPrompt(execution.memo as Record<string, unknown> | undefined);
    items.push(
      RunListItemSchema.parse({
        workflowId: execution.workflowId,
        runId: execution.runId,
        status: execution.status.name,
        startTime: execution.startTime.toISOString(),
        closeTime: execution.closeTime?.toISOString(),
        promptSnippet: prompt ? truncate(prompt, 120) : undefined,
      }),
    );
  }
  return { status: 200, body: items };
}

async function handleGetRun(deps: ControlDeps, workflowId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle<typeof platform>(workflowId);

  let description;
  try {
    description = await handle.describe();
  } catch {
    return { status: 404, body: { error: `no run found with workflowId "${workflowId}"` } };
  }

  const status = description.status.name;
  const prompt = memoPrompt(description.memo as Record<string, unknown> | undefined);
  const temporalUrl = `${deps.temporalUiBaseUrl}/namespaces/${deps.namespace}/workflows/${workflowId}/${description.runId}/history`;
  const base = { workflowId, runId: description.runId, status, prompt, temporalUrl };

  if (status === 'COMPLETED') {
    try {
      const result = await handle.result();
      const parsedResult = PlatformAgentResultSchema.safeParse(result);
      if (!parsedResult.success) {
        return {
          status: 200,
          body: RunDetailSchema.parse({ ...base, error: 'run completed but its result did not match the expected shape' }),
        };
      }
      return { status: 200, body: RunDetailSchema.parse({ ...base, result: parsedResult.data }) };
    } catch (err) {
      return {
        status: 200,
        body: RunDetailSchema.parse({ ...base, error: err instanceof Error ? err.message : 'failed to fetch workflow result' }),
      };
    }
  }

  if (status === 'RUNNING') {
    return { status: 200, body: RunDetailSchema.parse(base) };
  }

  return { status: 200, body: RunDetailSchema.parse({ ...base, error: `workflow ended with status ${status}` }) };
}

function handleListRepos(deps: ControlDeps): HandlerResponse {
  return { status: 200, body: RepoListResponseSchema.parse({ repos: deps.registry }) };
}

async function dispatch(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse | undefined> {
  const url = new URL(req.url ?? '/', 'http://control.local');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/healthz') {
    return { status: 200 };
  }
  if (req.method === 'POST' && pathname === '/api/platform/runs') {
    return handleStartRun(deps, req);
  }
  if (req.method === 'GET' && pathname === '/api/platform/runs') {
    return handleListRuns(deps, url);
  }
  const runMatch = matchPath('/api/platform/runs/:workflowId', pathname);
  if (req.method === 'GET' && runMatch) {
    return handleGetRun(deps, runMatch.params.workflowId);
  }
  if (req.method === 'GET' && pathname === '/api/registry/repos') {
    return handleListRepos(deps);
  }
  return undefined;
}

async function handleRequest(deps: ControlDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const result = await dispatch(deps, req);
    if (result) {
      if (result.body === undefined) {
        res.writeHead(result.status).end();
      } else {
        res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
      }
      return;
    }

    if (req.method === 'GET' && deps.uiDistPath) {
      const url = new URL(req.url ?? '/', 'http://control.local');
      const file = await resolveStaticFile(deps.uiDistPath, url.pathname);
      if (file) {
        res.writeHead(200, { 'content-type': file.contentType }).end(file.body);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error('control: unhandled error', err);
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
  }
}

export function createControlServer(deps: ControlDeps): Server {
  return createServer((req, res) => {
    void handleRequest(deps, req, res);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- packages/control/src/create-control-server.test.ts`
Expected: PASS. If `handle.describe()`'s mocked return shape trips a TypeScript error on `description.memo`/`description.status` typing in the test file, cast the mock's return value `as never` at the `mockResolvedValue(...)` call site, matching how `create-gateway-server.test.ts` casts its fake `Client` (`{ workflow: { start } } as never`) — the test only needs runtime shape, not a real `WorkflowExecutionDescription`.

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/create-control-server.ts packages/control/src/create-control-server.test.ts
git commit -m "feat(control): implement the platform console BFF routes"
```

---

## Task 6: Add `main.ts` and the package README

**Files:**
- Create: `packages/control/src/main.ts`
- Create: `packages/control/README.md`

No dedicated test for this step — it's an entrypoint wiring real env/`Connection.connect`, matching `packages/gateway/src/main.ts` and `packages/worker/src/main.ts`, neither of which has its own test file either.

- [ ] **Step 1: Write `main.ts`**

Create `packages/control/src/main.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { loadEnv } from '@agentops/activities';
import { createControlServer } from './create-control-server';
import { readRegistryRepos } from './read-registry-repos';

loadEnv();

async function main(): Promise<void> {
  const temporalUiBaseUrl = process.env.TEMPORAL_UI_BASE_URL;
  if (!temporalUiBaseUrl) {
    throw new Error('TEMPORAL_UI_BASE_URL is required');
  }

  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace });

  const registry = readRegistryRepos();
  console.log(
    registry.length > 0
      ? `agentops control: ${registry.length} repo(s) registered for the hint-repos picker`
      : 'agentops control: no PROJECT_REGISTRY_JSON set — hint-repos picker will offer no suggestions',
  );

  // packages/ui's build output, resolved relative to this file so it works
  // regardless of process.cwd() -- same "runs via tsx src/main.ts, not a
  // compiled dist/" convention as the worker/gateway images. Serving is
  // skipped entirely (404 for non-API GETs) until `pnpm --filter @agentops/ui
  // build` has produced this directory, so local dev without a UI build
  // doesn't crash.
  const uiDistPath = join(__dirname, '../../ui/dist');

  const server = createControlServer({
    client,
    taskQueue: process.env.TASK_QUEUE ?? 'agentops-devcycle',
    namespace,
    temporalUiBaseUrl,
    registry,
    uiDistPath: existsSync(uiDistPath) ? uiDistPath : undefined,
  });

  const port = Number(process.env.PORT ?? 3001);
  server.listen(port, () => {
    console.log(`agentops control listening on :${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Write the package README**

Create `packages/control/README.md`:

```markdown
# @agentops/control

Node HTTP BFF for the platform console — starts and inspects `platform`
Temporal workflow runs on behalf of `packages/ui`, via `@temporalio/client`.
No framework, plain `node:http`, matching `packages/gateway`'s convention.

## Run locally

Requires a running Temporal dev server (`temporal server start-dev`) and a
worker registered on the `agentops-devcycle` task queue.

```bash
TEMPORAL_UI_BASE_URL=http://localhost:8233 pnpm --filter @agentops/control run start
```

## Env vars

- `TEMPORAL_ADDRESS` (default `localhost:7233`)
- `TEMPORAL_NAMESPACE` (default `default`)
- `TASK_QUEUE` (default `agentops-devcycle`)
- `PROJECT_REGISTRY_JSON` (optional) — same format the worker/gateway use; only `repo` slugs are read, no tokens required
- `TEMPORAL_UI_BASE_URL` (required) — e.g. `http://localhost:8233` locally, or the cluster's Temporal Web UI host
- `PORT` (default `3001`)

## Production

Serves `packages/ui`'s built static assets itself once
`pnpm --filter @agentops/ui run build` has produced `packages/ui/dist` — see
`images/control/Dockerfile`. Locally, run `packages/ui`'s own Vite dev server
instead (see `packages/ui/README.md`), which proxies `/api/*` here.
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentops/control typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/control/src/main.ts packages/control/README.md
git commit -m "feat(control): add the entrypoint and package README"
```

---

## Task 7: Scaffold `packages/ui` and its build tooling

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vite.config.ts`
- Create: `packages/ui/index.html`
- Modify: `eslint.config.js`

This is the first browser package in the repo. Runtime deps (`react`, `react-dom`, `react-router-dom`) and build-time deps (`vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`) live in **`packages/ui`'s own** `package.json` — this repo's pnpm workspace has no hoisting override (no `.npmrc`), so a package can only `import` what it declares itself (confirmed by every existing package: `packages/worker` declares `pg`/`@kubernetes/client-node` itself rather than relying on anything root-level). Only `eslint-plugin-react-hooks` goes in the **root** `package.json`, because it's consumed by the root `eslint.config.js`, not by any file inside `packages/ui`.

- [ ] **Step 1: Create the package manifest**

Create `packages/ui/package.json`:

```json
{
  "name": "@agentops/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "pnpm run typecheck && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

Create `packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: Create the Vite config**

Create `packages/ui/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
```

- [ ] **Step 4: Create the HTML entry point**

Create `packages/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Platform Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Add `eslint-plugin-react-hooks` to the root and wire it into `eslint.config.js`**

Add `"eslint-plugin-react-hooks": "^5.0.0"` to the root `package.json`'s `devDependencies`.

In `eslint.config.js`, first check the installed plugin's flat-config export shape (`node_modules/eslint-plugin-react-hooks/package.json`'s `exports`/`main` field, or its dist output) — recent versions export either `configs.recommended` (a rules object) or `configs['recommended-latest']` (an array of config objects for flat config). Add a new block to the `defineConfig(...)` call in `eslint.config.js`, after the existing `packages/workflows/src/**/*.ts` block, using whichever shape is actually installed. If it exports a plain rules object:

```js
const reactHooks = require('eslint-plugin-react-hooks');
```

```js
  {
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
```

If it instead exports a flat-config array under a different key (e.g. `recommended-latest`), spread that array into `defineConfig(...)`'s top-level argument list scoped the same way, adapting to match. Either way, the resulting rule set must apply `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` to `packages/ui/src/**/*.{ts,tsx}` only.

- [ ] **Step 6: Install and verify**

```bash
pnpm install
pnpm --filter @agentops/ui typecheck
```
Expected: PASS (nothing to typecheck yet beyond the Vite config, but confirms the tsconfig/deps resolve correctly).

- [ ] **Step 7: Commit**

```bash
git add packages/ui/package.json packages/ui/tsconfig.json packages/ui/vite.config.ts packages/ui/index.html eslint.config.js package.json pnpm-lock.yaml
git commit -m "feat(ui): scaffold the Vite + React SPA package"
```

---

## Task 8: Add the typed API client

**Files:**
- Create: `packages/ui/src/api.ts`

No test file — per the design doc, `packages/ui` has no mandated automated tests; correctness is verified in Task 15's manual browser pass. Every response is still runtime-validated with the same zod schemas the server uses, so a contract mismatch fails loudly (a thrown `ZodError`) instead of silently rendering `undefined`.

- [ ] **Step 1: Write `api.ts`**

Create `packages/ui/src/api.ts`:

```ts
import { z } from 'zod';
import {
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunResponseSchema,
  type RunDetail,
  type RunListItem,
  type StartRunRequest,
  type StartRunResponse,
} from '@agentops/contracts';

async function parseJsonResponse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await res.json();
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new Error(message);
  }
  return schema.parse(body);
}

export async function startRun(input: StartRunRequest): Promise<StartRunResponse> {
  const res = await fetch('/api/platform/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJsonResponse(res, StartRunResponseSchema);
}

export async function listRuns(limit = 20): Promise<RunListItem[]> {
  const res = await fetch(`/api/platform/runs?limit=${limit}`);
  return parseJsonResponse(res, z.array(RunListItemSchema));
}

export async function getRun(workflowId: string): Promise<RunDetail> {
  const res = await fetch(`/api/platform/runs/${encodeURIComponent(workflowId)}`);
  return parseJsonResponse(res, RunDetailSchema);
}

export async function listRepos(): Promise<string[]> {
  const res = await fetch('/api/registry/repos');
  const parsed = await parseJsonResponse(res, RepoListResponseSchema);
  return parsed.repos;
}

/**
 * Builds a Temporal Web UI link for a different workflow (e.g. a
 * childWorkflow or an actionsTaken target) by swapping the workflowId
 * segment out of an existing run's temporalUrl, dropping any run-id/history
 * suffix -- Temporal resolves a workflow-only URL to its latest run.
 */
export function siblingTemporalUrl(temporalUrl: string, targetWorkflowId: string): string {
  const match = /^(.*\/namespaces\/[^/]+\/workflows\/)[^/]+(?:\/.*)?$/.exec(temporalUrl);
  if (!match) {
    return temporalUrl;
  }
  return `${match[1]}${encodeURIComponent(targetWorkflowId)}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/api.ts
git commit -m "feat(ui): add the typed API client"
```

---

## Task 9: Add `StatusBadge` and shared styles

**Files:**
- Create: `packages/ui/src/components/StatusBadge.tsx`
- Create: `packages/ui/src/styles.css`

- [ ] **Step 1: Write `StatusBadge.tsx`**

Create `packages/ui/src/components/StatusBadge.tsx`:

```tsx
import type { RunStatus } from '@agentops/contracts';

const STATUS_COLORS: Record<RunStatus, string> = {
  RUNNING: '#2563eb',
  COMPLETED: '#16a34a',
  FAILED: '#dc2626',
  CANCELLED: '#d97706',
  TERMINATED: '#dc2626',
  TIMED_OUT: '#dc2626',
  CONTINUED_AS_NEW: '#2563eb',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className="status-badge" style={{ backgroundColor: STATUS_COLORS[status] }}>
      {status}
    </span>
  );
}
```

- [ ] **Step 2: Write `styles.css`**

Create `packages/ui/src/styles.css`:

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #1f2937;
  background: #f9fafb;
}

.page {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px 16px 64px;
}

h1 {
  font-size: 22px;
  margin-bottom: 24px;
}

h2 {
  font-size: 16px;
  margin-top: 40px;
}

.field-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #4b5563;
  margin: 16px 0 6px;
}

.prompt-input,
.text-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.chip {
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid #d1d5db;
  background: white;
  cursor: pointer;
}

.chip:hover {
  background: #f3f4f6;
}

.actions {
  margin-top: 20px;
}

.run-button {
  padding: 10px 20px;
  border-radius: 6px;
  border: none;
  background: #2563eb;
  color: white;
  font-weight: 600;
  cursor: pointer;
}

.run-button:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}

.error-text {
  color: #dc2626;
  font-size: 13px;
}

.error-box {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 12px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid #e5e7eb;
}

.status-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  color: white;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.back-link {
  font-size: 13px;
  color: #4b5563;
  text-decoration: none;
}

.run-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 8px;
}

.run-id {
  font-family: monospace;
  font-size: 13px;
  color: #4b5563;
}

.temporal-link {
  margin-left: auto;
  font-size: 13px;
}

.section {
  margin-top: 20px;
}

.prompt-text {
  white-space: pre-wrap;
}

.summary-text {
  white-space: pre-wrap;
  font-family: inherit;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 12px;
  font-size: 13px;
}

.child-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  width: 220px;
  background: white;
}

.card h3 {
  margin: 0 0 6px;
  font-size: 13px;
}

.card p {
  margin: 0 0 8px;
  font-size: 12px;
  color: #4b5563;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/StatusBadge.tsx packages/ui/src/styles.css
git commit -m "feat(ui): add the status badge component and shared styles"
```

---

## Task 10: Build `HomePage`

**Files:**
- Create: `packages/ui/src/pages/HomePage.tsx`

- [ ] **Step 1: Write `HomePage.tsx`**

Create `packages/ui/src/pages/HomePage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RunListItem } from '@agentops/contracts';
import { listRepos, listRuns, startRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const SUGGESTED_PROMPTS = [
  'Check recent failed workflows — anything strange?',
  'Investigate the last workflow failures and propose fixes',
  'Check cluster pod health in dev-agents',
];

export function HomePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [hintReposText, setHintReposText] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRepos()
      .then(setRepoSuggestions)
      .catch(() => setRepoSuggestions([]));
    listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  const canSubmit = prompt.trim().length > 0 && !submitting;

  async function handleRun() {
    setSubmitting(true);
    setError(null);
    try {
      const hintRepos = hintReposText
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean);
      const { workflowId } = await startRun({
        prompt: prompt.trim(),
        hintRepos: hintRepos.length > 0 ? hintRepos : undefined,
      });
      navigate(`/runs/${workflowId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start run');
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>Platform Console</h1>

      <label className="field-label" htmlFor="prompt">
        What should the platform agent investigate?
      </label>
      <textarea
        id="prompt"
        className="prompt-input"
        rows={4}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />

      <div className="chip-row">
        {SUGGESTED_PROMPTS.map((suggestion) => (
          <button key={suggestion} type="button" className="chip" onClick={() => setPrompt(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>

      <label className="field-label" htmlFor="hint-repos">
        Hint repos (optional)
      </label>
      <input
        id="hint-repos"
        className="text-input"
        placeholder="owner/repo, owner/repo2"
        value={hintReposText}
        onChange={(event) => setHintReposText(event.target.value)}
        list="repo-suggestions"
      />
      <datalist id="repo-suggestions">
        {repoSuggestions.map((repo) => (
          <option key={repo} value={repo} />
        ))}
      </datalist>

      <div className="actions">
        <button type="button" className="run-button" disabled={!canSubmit} onClick={handleRun}>
          {submitting ? 'Starting…' : 'Run'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      <h2>Recent runs</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Prompt</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.workflowId}>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{run.promptSnippet ?? run.workflowId}</td>
              <td>{new Date(run.startTime).toLocaleString()}</td>
              <td>
                <Link to={`/runs/${run.workflowId}`}>Open</Link>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={4}>No runs yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/pages/HomePage.tsx
git commit -m "feat(ui): build the home page"
```

---

## Task 11: Build `RunDetailPage`

**Files:**
- Create: `packages/ui/src/pages/RunDetailPage.tsx`

- [ ] **Step 1: Write `RunDetailPage.tsx`**

Create `packages/ui/src/pages/RunDetailPage.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { RunDetail } from '@agentops/contracts';
import { getRun, siblingTemporalUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const POLL_INTERVAL_MS = 3000;

export function RunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) {
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const detail = await getRun(workflowId!);
        if (cancelled) {
          return;
        }
        setRun(detail);
        if (detail.status !== 'RUNNING' && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load run');
        }
      }
    }

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [workflowId]);

  if (error) {
    return (
      <div className="page">
        <p className="error-text">{error}</p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <a href="/" className="back-link">
        ← Back
      </a>
      <div className="run-header">
        <StatusBadge status={run.status} />
        <span className="run-id">{run.workflowId}</span>
        <a className="temporal-link" href={run.temporalUrl} target="_blank" rel="noreferrer">
          Open in Temporal ↗
        </a>
      </div>

      {run.prompt && (
        <div className="section">
          <div className="field-label">Prompt</div>
          <p className="prompt-text">{run.prompt}</p>
        </div>
      )}

      {run.error && (
        <div className="section error-box">
          <div className="field-label">Error</div>
          <p>{run.error}</p>
        </div>
      )}

      {run.result && (
        <>
          <div className="section">
            <div className="field-label">Summary</div>
            <pre className="summary-text">{run.result.summary}</pre>
          </div>

          {run.result.actionsTaken.length > 0 && (
            <div className="section">
              <div className="field-label">Actions taken</div>
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Workflow</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.actionsTaken.map((action, index) => (
                    <tr key={index}>
                      <td>{action.type}</td>
                      <td>
                        <a href={siblingTemporalUrl(run.temporalUrl, action.workflowId)} target="_blank" rel="noreferrer">
                          {action.workflowId}
                        </a>
                      </td>
                      <td>{action.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {run.result.childWorkflows.length > 0 && (
            <div className="section">
              <div className="field-label">Child workflows</div>
              <div className="child-cards">
                {run.result.childWorkflows.map((child) => (
                  <div className="card" key={child.workflowId}>
                    <h3>{child.repo}</h3>
                    <p>{child.goal}</p>
                    <a href={siblingTemporalUrl(run.temporalUrl, child.workflowId)} target="_blank" rel="noreferrer">
                      {child.workflowId} ↗
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/pages/RunDetailPage.tsx
git commit -m "feat(ui): build the run detail page"
```

---

## Task 12: Wire up routing and update the package README

**Files:**
- Create: `packages/ui/src/App.tsx`
- Create: `packages/ui/src/main.tsx`
- Modify: `packages/ui/README.md`

- [ ] **Step 1: Write `App.tsx`**

Create `packages/ui/src/App.tsx`:

```tsx
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { RunDetailPage } from './pages/RunDetailPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:workflowId" element={<RunDetailPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 2: Write `main.tsx`**

Create `packages/ui/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 3: Replace the placeholder `packages/ui/README.md`**

Replace the contents of `packages/ui/README.md` (currently the M0 placeholder) with:

```markdown
# @agentops/ui

Platform Console — a minimal Vite + React SPA for starting and watching
`platform` Temporal workflow runs. Talks only to `packages/control`'s `/api/*`
routes; no direct Temporal SDK usage in the browser.

## Run locally

Needs `packages/control` running on port 3001 (see its own README) — this
dev server proxies `/api/*` there.

```bash
pnpm --filter @agentops/ui dev
```

Open http://localhost:5173.

## Build

```bash
pnpm --filter @agentops/ui build
```

Output goes to `packages/ui/dist`, which `packages/control` serves directly
in production (see `packages/control/src/main.ts` and
`images/control/Dockerfile`) — there is no separate ui deployment.

## Routes

- `/` — prompt input, suggested-prompt chips, optional hint-repos, and a
  table of recent `platform` runs.
- `/runs/:workflowId` — live status (polls every 3s while `RUNNING`), then
  the run's summary, actions taken, and any child `devCycle` fixes it
  started, plus a link to the run in Temporal Web UI.

Full design: `docs/superpowers/specs/2026-07-07-platform-console-design.md`.
```

- [ ] **Step 4: Typecheck the whole package**

Run: `pnpm --filter @agentops/ui typecheck`
Expected: PASS. Fix any type errors surfaced by the real component code now in place (this is the first point every file in the package has existed together).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/App.tsx packages/ui/src/main.tsx packages/ui/README.md
git commit -m "feat(ui): wire up routing and update the package README"
```

---

## Task 13: Helm chart — `control` Deployment, Service, Ingress

**Files:**
- Create: `charts/engine/templates/control-deployment.yaml`
- Create: `charts/engine/templates/control-service.yaml`
- Create: `charts/engine/templates/control-ingress.yaml`
- Modify: `charts/engine/values.yaml`
- Modify: `charts/engine/tests/render.golden.yaml` (regenerated, not hand-edited)

- [ ] **Step 1: Add values**

In `charts/engine/values.yaml`, add `controlTag` next to the existing image tags:

```yaml
image:
  repository: gitactions.est1908.top/agentic-ops
  workerTag: CHANGEME
  agentRunnerTag: CHANGEME
  gatewayTag: CHANGEME
  controlTag: CHANGEME
  pullPolicy: IfNotPresent
```

Add a top-level `temporalUiBaseUrl`, next to `temporalAddress`, following the same "chart ships no cluster assumption" pattern as `otelExporterOtlpEndpoint`:

```yaml
temporalAddress: "localhost:7233"

# Empty by default -- same "chart ships no cluster assumption" pattern as
# otelExporterOtlpEndpoint below. agentops-platform's values override sets
# the real Temporal Web UI host once one exists for the cluster.
temporalUiBaseUrl: ""
```

Add a `control:` block after the existing `gateway:` block, at the end of the file:

```yaml
control:
  port: 3001
  # Disabled by default, same reasoning as gateway.ingress -- this chart
  # ships no real public hostname.
  ingress:
    enabled: false
    host: ""
    clusterIssuer: letsencrypt
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
```

- [ ] **Step 2: Add the Deployment**

Create `charts/engine/templates/control-deployment.yaml`, following `gateway-deployment.yaml`'s shape but without the per-project `GITHUB_TOKEN__<PRODUCT>` env vars gateway needs — `control` only reads repo slugs from `PROJECT_REGISTRY_JSON`, never a token:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-control
  namespace: {{ .Values.namespace }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}-control
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-control
    spec:
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      imagePullSecrets:
        - name: {{ .Values.imagePullSecretName }}
      containers:
        - name: control
          image: "{{ .Values.image.repository }}/control:{{ .Values.image.controlTag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext:
            {{- toYaml .Values.containerSecurityContext | nindent 12 }}
          ports:
            - containerPort: {{ .Values.control.port }}
          env:
            - name: PORT
              value: {{ .Values.control.port | quote }}
            - name: TEMPORAL_ADDRESS
              value: {{ .Values.temporalAddress | quote }}
            - name: TEMPORAL_NAMESPACE
              value: {{ .Values.temporal.namespace | quote }}
            - name: TASK_QUEUE
              value: {{ .Values.taskQueue | quote }}
            - name: TEMPORAL_UI_BASE_URL
              value: {{ .Values.temporalUiBaseUrl | quote }}
            - name: PROJECT_REGISTRY_JSON
              value: {{ include "engine.projectRegistryJson" . | quote }}
          resources:
            {{- toYaml .Values.control.resources | nindent 12 }}
          readinessProbe:
            httpGet:
              path: /healthz
              port: {{ .Values.control.port }}
          livenessProbe:
            httpGet:
              path: /healthz
              port: {{ .Values.control.port }}
```

- [ ] **Step 3: Add the Service**

Create `charts/engine/templates/control-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-control
  namespace: {{ .Values.namespace }}
spec:
  selector:
    app: {{ .Release.Name }}-control
  ports:
    - port: {{ .Values.control.port }}
      targetPort: {{ .Values.control.port }}
```

- [ ] **Step 4: Add the Ingress**

Create `charts/engine/templates/control-ingress.yaml`:

```yaml
{{- if .Values.control.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}-control
  namespace: {{ .Values.namespace }}
  annotations:
    cert-manager.io/cluster-issuer: {{ .Values.control.ingress.clusterIssuer }}
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - {{ .Values.control.ingress.host | quote }}
      secretName: {{ .Release.Name }}-control-tls
  rules:
    - host: {{ .Values.control.ingress.host | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-control
                port:
                  number: {{ .Values.control.port }}
{{- end }}
```

- [ ] **Step 5: Lint the chart**

Run: `helm lint charts/engine`
Expected: PASS (0 chart(s) failed).

- [ ] **Step 6: Regenerate the golden render file**

The golden test is an exact `diff` against `helm template`'s output — regenerate it rather than hand-editing:

```bash
cd charts/engine
helm template engine . --namespace dev-agents > tests/render.golden.yaml
cd ../..
bash charts/engine/tests/run.sh
```
Expected: `run.sh` produces no diff output (exit 0). Inspect the diff `git diff charts/engine/tests/render.golden.yaml` to confirm it added exactly one new Deployment and one new Service `# Source:` block for `control` (the Ingress renders nothing, since `control.ingress.enabled` defaults to `false` — same as `gateway-ingress.yaml` today) and nothing else changed.

- [ ] **Step 7: Commit**

```bash
git add charts/engine/templates/control-deployment.yaml charts/engine/templates/control-service.yaml charts/engine/templates/control-ingress.yaml charts/engine/values.yaml charts/engine/tests/render.golden.yaml
git commit -m "feat(chart): add control Deployment/Service/Ingress"
```

---

## Task 14: Docker image and CI

**Files:**
- Create: `images/control/Dockerfile`
- Modify: `.github/workflows/ci.yaml`
- Modify: `scripts/bump-platform-engine-tags.sh`

- [ ] **Step 1: Write the Dockerfile**

Create `images/control/Dockerfile`, matching `images/gateway/Dockerfile`'s existing (single-stage, whole-monorepo) shape — not a leaner multi-stage build, since that's not this repo's established pattern — but building `packages/ui` first so its `dist/` exists for `control` to serve:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# Same rationale as images/worker/Dockerfile and images/gateway/Dockerfile:
# baked-in pnpm, not `corepack enable` alone, to avoid a runtime fetch the
# dev-agents NetworkPolicy (GitHub + Anthropic + DNS only) would block.
RUN npm install --global pnpm@9.15.9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentops/ui run build
RUN pnpm --filter @agentops/control run typecheck
RUN chown -R node:node /app

# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/control", "run", "start"]
```

- [ ] **Step 2: Add the CI build step**

In `.github/workflows/ci.yaml`'s `build-images` job, add a new step after the existing gateway image step:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/control/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/control:${{ github.sha }}
```

- [ ] **Step 3: Add the tag-bump substitution**

In `scripts/bump-platform-engine-tags.sh`'s embedded Python block, add one more `re.sub` call alongside the existing three, and add the touched file to the trailing `git add`:

```python
text = re.sub(r"^(  gatewayTag:\s*).*$", rf'\g<1>"{sha}"', text, flags=re.M)
text = re.sub(r"^(  controlTag:\s*).*$", rf'\g<1>"{sha}"', text, flags=re.M)
values.write_text(text)
```

This substitution is a no-op until `agentops-platform`'s `clusters/ops/engine/values.yaml` has a `controlTag` key to match — that's `agentops-platform`-side work, tracked as a precondition (see the design doc §8), not built in this PR.

- [ ] **Step 4: Validate the Dockerfile builds**

```bash
docker build -f images/control/Dockerfile -t agentops-control-test .
```
Expected: builds successfully through `pnpm --filter @agentops/ui run build` and `pnpm --filter @agentops/control run typecheck`. This also serves as a real end-to-end verification that `packages/ui`'s production build actually succeeds, not just its dev-mode typecheck.

- [ ] **Step 5: Commit**

```bash
git add images/control/Dockerfile .github/workflows/ci.yaml scripts/bump-platform-engine-tags.sh
git commit -m "feat(ci): build and tag the control image"
```

---

## Task 15: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full local check suite**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```
Expected: all green. This doesn't touch `packages/workflows`/`policies`/`activities`/`backends` behavior, so `pnpm e2e` should be unaffected, but AGENTS.md's definition of done requires it green regardless — run it to confirm no incidental breakage (e.g. from the `packages/activities` import used by `packages/control`).

- [ ] **Step 2: Re-run the Helm checks**

```bash
helm lint charts/engine
bash charts/engine/tests/run.sh
```
Expected: both clean.

- [ ] **Step 3: Drive the golden path in a real browser**

Required by this repo's own frontend-verification convention — do not skip. In separate terminals:

```bash
# terminal 1
temporal server start-dev

# terminal 2
pnpm worker

# terminal 3
TEMPORAL_UI_BASE_URL=http://localhost:8233 pnpm --filter @agentops/control run start

# terminal 4
pnpm --filter @agentops/ui run dev
```

With no `.env`/`PROJECT_REGISTRY_JSON` set, the worker runs in DEMO mode (stub backend, in-memory ports, zero token spend) — the `platform` workflow's `runAgent` call uses whatever backend routing the worker resolves by default for the `platform` role; if it isn't the `stub` backend outside a real registry, expect this manual run to actually invoke a real agent CLI, which is fine for a one-off local verification pass but costs real tokens — check `packages/worker/src/main.ts`'s `buildBackends` output before running if that's a concern, and prefer a disposable/local Temporal namespace either way.

Open http://localhost:5173 and:
1. Click a suggested-prompt chip, confirm it fills the textarea.
2. Type a real prompt, click Run — confirm it navigates to `/runs/:workflowId`.
3. Confirm the detail page shows a `RUNNING` badge and polls (watch the Network tab: repeated `GET /api/platform/runs/:workflowId` roughly every 3s).
4. Once the workflow completes, confirm the page shows `summary`, and confirm the "Open in Temporal" link opens the real run in Temporal Web UI at `http://localhost:8233`.
5. Go back to `/`, confirm the new run now appears in the recent-runs table with a prompt snippet (not just its raw workflowId).

If anything in this pass doesn't match, fix it before proceeding — this is the actual acceptance criteria, not just green CI.

- [ ] **Step 4: Commit any fixes found during manual verification**

If Step 3 surfaced any bugs, fix them, re-run the affected package's tests, and commit:

```bash
git add -A
git commit -m "fix: address issues found in manual golden-path verification"
```
(Skip this step entirely if nothing needed fixing.)

---

## Task 16: Open the PR, pass CI, and resolve the Bugbot review

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
gh pr create --base main --fill --title "feat: add the platform console (control BFF + ui SPA)"
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
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=flair-hr -F r=agentops-engine -F p=<number>
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
