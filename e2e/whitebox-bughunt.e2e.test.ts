import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whiteboxBugHunt } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, type TestEnv } from './helpers';
import type { ResolvedProjectEntry } from '@agentops/contracts';

const FINDINGS =
  'FINDINGS: [{"title":"SQLi in login","detail":"...","severity":"high","location":"src/auth.ts:42"}]';

describe('whiteboxBugHunt (SP1 gate)', () => {
  let t: TestEnv;
  beforeEach(async () => {
    const registry: ResolvedProjectEntry[] = [
      { trackerType: 'github', project: 'acme', repo: 'acme/webapp', token: 'tkn' },
    ];
    t = await buildTestEnv({ registry });
  });
  afterEach(async () => teardownTestEnv(t));

  it('files a deduped bug issue; a second identical run files no duplicate', async () => {
    t.stub.scriptResponse('bughunt', 1, { output: FINDINGS });

    const [first, second] = await t.worker.runUntil(async () => {
      const h1 = await t.env.client.workflow.start(whiteboxBugHunt, {
        taskQueue: t.taskQueue,
        workflowId: 'wbh-1',
        args: [{ repo: 'acme/webapp' }],
      });
      const r1 = await h1.result();

      const h2 = await t.env.client.workflow.start(whiteboxBugHunt, {
        taskQueue: t.taskQueue,
        workflowId: 'wbh-2',
        args: [{ repo: 'acme/webapp' }],
      });
      const r2 = await h2.result();

      return [r1, r2];
    });
    expect(first).toEqual({ filed: 1, deduped: 0 });
    const created = t.tracker.listCreated?.() ?? [];
    expect(created).toHaveLength(1);
    const issue = await t.tracker.getIssue(created[0].ref);
    expect(issue.labels).toContain('bug');

    expect(second).toEqual({ filed: 0, deduped: 1 }); // same fingerprint -> no new issue
  });
});
