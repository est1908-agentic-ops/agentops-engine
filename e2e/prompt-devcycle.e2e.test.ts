import { afterEach, describe, expect, it } from 'vitest';
import { StubBackend } from '@agentops/backends';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: prompt-started run resolves config in-workflow', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('resolves config on the worker for a registered repo and reaches done', async () => {
    // A worker-resolved config carries the FULL default routing
    // (parseProjectConfig merges DEFAULT_PROJECT_CONFIG), which sends
    // `implement` to the `pi` backend -- unlike existing e2e tests, whose
    // hand-passed `routing: {}` bypasses that merge. Register a stub as
    // `pi` so the implement stage has a backend to land on.
    const piStub = new StubBackend();
    testEnv = await buildTestEnv({
      registry: [
        {
          project: 'demo',
          repo: 'demo/repo',
          trackerType: 'github',
          tokenEnvVar: 'DEMO_TOKEN',
          token: 'test-token',
        },
      ],
      extraBackends: { pi: piStub },
    });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    piStub.scriptResponse('implement', 1, { output: 'diff --git a/widget.ts b/widget.ts' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    // No config on purpose: this is exactly what control sends.
    const input: TaskInput = {
      taskId: 'prompt-task-1',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Add a widget from a console prompt',
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: `prompt-demo-${input.taskId}`,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 30_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(finalState.stage).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });

  it('fails fast with unregistered-repo when the worker does not know the repo', async () => {
    testEnv = await buildTestEnv(); // empty registry
    const { env, worker, taskQueue } = testEnv;

    const input: TaskInput = {
      taskId: 'prompt-task-2',
      project: 'default',
      repo: 'nobody/unknown',
      goal: 'Do something',
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: `prompt-default-${input.taskId}`,
        args: [input],
      });
      return handle.result();
    });

    expect(finalState.status).toBe('failed');
    expect(finalState.stage).toBe('failed');
    expect(finalState.blockReason).toBe('unregistered-repo');
    // Fail-fast happens before prepareWorkspace -- nothing was ever prepared.
    expect(finalState.workspaceRef).toBe('');
  });
});
