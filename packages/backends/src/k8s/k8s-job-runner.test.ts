import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { createClaudeCliSpec } from '../claude/claude-backend';
import { ProcessCliAuthError } from '../process-cli-runner';
import { FakeBatchApi } from './fake-batch-api';
import {
  agentOpsArtifactPaths,
  buildAgentJob,
  K8sJobRunner,
  k8sJobName,
} from './k8s-job-runner';

const baseRequest: BackendRunRequest = {
  taskId: 'task-1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'claude',
  model: 'claude-sonnet-5',
  workspaceRef: '/workspace/tasks/task-1',
  limits: { maxTokens: 1000, timeoutMs: 30_000 },
  prompt: 'do the thing',
};

describe('k8sJobName', () => {
  it('sanitizes task ids for Kubernetes names', () => {
    expect(
      k8sJobName({ ...baseRequest, taskId: 'Owner/Repo#42' }),
    ).toBe('agentops-owner-repo-42-implement-1-1');
  });
});

describe('buildAgentJob', () => {
  it('builds the expected Job shape with shell-safe positional args', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
      },
      paths,
    );

    expect(job.metadata?.name).toBe('agentops-task-1-implement-1-1');
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(300);
    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe('ghcr.io/example/agent-claude:abc');
    expect(container?.workingDir).toBe('/workspace/tasks/task-1');
    expect(container?.command).toEqual([
      '/bin/sh',
      '-c',
      'exec "$0" "$@" < "$PROMPT_FILE" > "$OUT_FILE" 2> "$ERR_FILE"',
      'claude',
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-5',
      '--max-turns',
      '30',
      '--dangerously-skip-permissions',
    ]);
    expect(container?.env).toEqual([
      { name: 'PROMPT_FILE', value: paths.promptFile },
      { name: 'OUT_FILE', value: paths.outFile },
      { name: 'ERR_FILE', value: paths.errFile },
    ]);
    expect(container?.volumeMounts).toEqual([{ name: 'workspace-tasks', mountPath: '/workspace/tasks' }]);
    expect(container?.securityContext).toEqual({ runAsNonRoot: true, allowPrivilegeEscalation: false });
    expect(container?.envFrom).toBeUndefined();
  });

  it('wires envFrom from authSecretName when provided', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        authSecretName: 'claude-credentials',
      },
      paths,
    );

    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container?.envFrom).toEqual([{ secretRef: { name: 'claude-credentials' } }]);
  });

  it('wires imagePullSecrets from imagePullSecretName when provided', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        imagePullSecretName: 'registry-credentials',
      },
      paths,
    );

    expect(job.spec?.template?.spec?.imagePullSecrets).toEqual([{ name: 'registry-credentials' }]);
  });
});

describe('K8sJobRunner', () => {
  it('writes the prompt, creates a Job, polls to success, and parses output from the PVC files', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    let now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec(), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      now: () => now,
      heartbeat: () => {},
    });

    const runPromise = runner.run(req);
    await vi.waitFor(() => expect(batchApi.creates).toHaveLength(1));

    const jobName = k8sJobName(req);
    await writeFile(
      paths.outFile,
      JSON.stringify({
        is_error: false,
        result: 'done',
        usage: { input_tokens: 3, output_tokens: 4 },
        duration_ms: 50,
      }),
      'utf8',
    );
    batchApi.setJobStatus(jobName, { succeeded: 1 });
    now += 10;

    await expect(runPromise).resolves.toEqual({
      output: 'done',
      tokensIn: 3,
      tokensOut: 4,
      wallMs: 50,
    });
  });

  it('deletes the Job and rethrows when heartbeat fails (cancellation)', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-cancel-'));
    const req = { ...baseRequest, workspaceRef };
    const batchApi = new FakeBatchApi();
    const cancelError = new Error('activity cancelled');

    const runner = new K8sJobRunner(createClaudeCliSpec(), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1_000,
      heartbeat: () => {
        throw cancelError;
      },
    });

    await expect(runner.run(req)).rejects.toThrow('activity cancelled');
    expect(batchApi.deletes).toEqual([
      {
        name: k8sJobName(req),
        namespace: 'dev-agents',
        opts: { propagationPolicy: 'Background' },
      },
    ]);
  });

  it('throws ProcessCliAuthError when stderr matches the auth pattern', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-auth-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    const runner = new K8sJobRunner(createClaudeCliSpec(), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      heartbeat: () => {},
    });

    const runPromise = runner.run(req);
    await vi.waitFor(() => expect(batchApi.creates).toHaveLength(1));

    await writeFile(paths.errFile, 'Error: invalid api key', 'utf8');
    batchApi.setJobStatus(k8sJobName(req), { failed: 1 });

    await expect(runPromise).rejects.toThrow(ProcessCliAuthError);
  });
});
