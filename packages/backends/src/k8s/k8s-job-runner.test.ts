import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { createClaudeCliSpec } from '../claude/claude-backend';
import type { CliSpec } from '../cli-spec';
import { ProcessCliAuthError, ProcessCliProcessError } from '../process-cli-runner';
import { FakeBatchApi } from './fake-batch-api';
import type { V1Job } from './k8s-types';
import {
  agentOpsArtifactPaths,
  buildAgentJob,
  K8sJobRunner,
  k8sJobName,
} from './k8s-job-runner';

// Simulates the readNamespacedJobStatus K8s API call hanging (e.g. an
// unreachable API server) for the first `hangsLeft` polls before behaving
// normally -- reproduces the issue-broccoli-94 incident, where a hung status
// read froze the whole poll loop until Temporal's 15s heartbeat timeout fired
// identically on every one of 5 retries (see
// project_k8s_job_poll_no_timeout memory / the design doc's non-goals).
class HangThenRealBatchApi extends FakeBatchApi {
  constructor(private hangsLeft: number) {
    super();
  }

  override async readNamespacedJobStatus(name: string, namespace: string): Promise<{ body: V1Job }> {
    if (this.hangsLeft > 0) {
      this.hangsLeft--;
      return new Promise<{ body: V1Job }>(() => {});
    }
    return super.readNamespacedJobStatus(name, namespace);
  }
}

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
    expect(k8sJobName({ ...baseRequest, taskId: 'Owner/Repo#42' })).toMatch(
      /^agentops-owner-repo-42-implement-1-1-[0-9a-f]{8}$/,
    );
  });

  it('stays deterministic for the same request (Temporal retries reuse the same Job)', () => {
    expect(k8sJobName(baseRequest)).toBe(k8sJobName(baseRequest));
  });

  // A RateLimitFallbackBackend retry reruns the same call with a different
  // model. If the Job name and artifact paths ignored the model, that retry
  // would 409-reuse the primary model's already-finished Job and re-read its
  // (rate-limited) output instead of actually running the fallback.
  it('derives a distinct Job name and artifact paths per model', () => {
    const primary = { ...baseRequest, model: 'zai/glm-5.2' };
    const fallback = { ...baseRequest, model: 'openrouter/deepseek-v4-pro' };
    expect(k8sJobName(primary)).not.toBe(k8sJobName(fallback));
    expect(agentOpsArtifactPaths(primary).outFile).not.toBe(agentOpsArtifactPaths(fallback).outFile);
  });
});

describe('buildAgentJob', () => {
  it('refuses to build a Job against a placeholder "CHANGEME" image', () => {
    const paths = agentOpsArtifactPaths(baseRequest);

    expect(() =>
      buildAgentJob(
        baseRequest,
        createClaudeCliSpec({ image: 'ghcr.io/CHANGEME/agentops-engine/agent-claude:CHANGEME' }),
        { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
        paths,
      ),
    ).toThrow(/CHANGEME/);
  });

  it('refuses to build a Job when the project-supplied image (req.image) is still a placeholder', () => {
    const paths = agentOpsArtifactPaths(baseRequest);

    expect(() =>
      buildAgentJob(
        { ...baseRequest, image: 'ghcr.io/CHANGEME/some-project:CHANGEME' },
        createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
        { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
        paths,
      ),
    ).toThrow(/CHANGEME/);
  });

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

    expect(job.metadata?.name).toMatch(/^agentops-task-1-implement-1-1-[0-9a-f]{8}$/);
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(300);
    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe('ghcr.io/example/agent-claude:abc');
    expect(container?.workingDir).toBe('/workspace/tasks/task-1');
    expect(container?.command).toEqual([
      '/bin/sh',
      '-c',
      [
        'rm -f /tmp/agentops-out /tmp/agentops-err',
        'mkfifo /tmp/agentops-out /tmp/agentops-err',
        'tee "$OUT_FILE" < /tmp/agentops-out &',
        'tee "$ERR_FILE" < /tmp/agentops-err >&2 &',
        '"$0" "$@" < "$PROMPT_FILE" > /tmp/agentops-out 2> /tmp/agentops-err',
        'CODE=$?',
        'wait',
        'exit "$CODE"',
      ].join('\n'),
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-sonnet-5',
      '--dangerously-skip-permissions',
    ]);
    expect(container?.env).toEqual([
      { name: 'PROMPT_FILE', value: paths.promptFile },
      { name: 'OUT_FILE', value: paths.outFile },
      { name: 'ERR_FILE', value: paths.errFile },
    ]);
    expect(container?.volumeMounts).toEqual([{ name: 'workspace-tasks', mountPath: '/workspace/tasks' }]);
    expect(job.spec?.template?.spec?.securityContext).toEqual({ runAsNonRoot: true, runAsUser: 1000 });
    expect(container?.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      allowPrivilegeEscalation: false,
    });
    expect(container?.envFrom).toBeUndefined();
  });

  it('also mounts the base-clone cache PVC when cachePvcName/cacheMountPath are set, so the worktree gitdir resolves in the Job pod', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        cachePvcName: 'workspace-cache',
        cacheMountPath: '/workspace/cache',
      },
      paths,
    );

    expect(job.spec?.template?.spec?.volumes).toEqual([
      { name: 'workspace-tasks', persistentVolumeClaim: { claimName: 'workspace-tasks' } },
      { name: 'workspace-cache', persistentVolumeClaim: { claimName: 'workspace-cache' } },
    ]);
    expect(job.spec?.template?.spec?.containers?.[0]?.volumeMounts).toEqual([
      { name: 'workspace-tasks', mountPath: '/workspace/tasks' },
      { name: 'workspace-cache', mountPath: '/workspace/cache' },
    ]);
  });

  it('omits the cache volume when only one of cachePvcName/cacheMountPath is set', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks', cachePvcName: 'workspace-cache' },
      paths,
    );

    expect(job.spec?.template?.spec?.volumes).toEqual([
      { name: 'workspace-tasks', persistentVolumeClaim: { claimName: 'workspace-tasks' } },
    ]);
    expect(job.spec?.template?.spec?.containers?.[0]?.volumeMounts).toEqual([
      { name: 'workspace-tasks', mountPath: '/workspace/tasks' },
    ]);
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

  it('uses a custom runAsUser when provided', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        runAsUser: 2000,
      },
      paths,
    );

    const container = job.spec?.template?.spec?.containers?.[0];
    expect(job.spec?.template?.spec?.securityContext).toEqual({ runAsNonRoot: true, runAsUser: 2000 });
    expect(container?.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 2000,
      allowPrivilegeEscalation: false,
    });
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

  it('uses req.image instead of spec.image when the request declares one', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      { ...baseRequest, image: 'gitactions.est1908.top/acme/agentops:latest' },
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );
    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe('gitactions.est1908.top/acme/agentops:latest');
  });

  it('has no initContainers when the request declares no services', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );
    expect(job.spec?.template?.spec?.initContainers).toBeUndefined();
  });

  it('renders req.services as native sidecar initContainers with restartPolicy Always', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      {
        ...baseRequest,
        services: [
          {
            name: 'postgres',
            image: 'pgvector/pgvector:pg18',
            env: { POSTGRES_USER: 'acme', POSTGRES_PASSWORD: 'acme' },
            readiness: { type: 'exec', command: ['pg_isready', '-U', 'acme'] },
          },
          {
            name: 'redis',
            image: 'redis:7-alpine',
            readiness: { type: 'tcpSocket', port: 6379 },
          },
        ],
      },
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );

    expect(job.spec?.template?.spec?.initContainers).toEqual([
      {
        name: 'postgres',
        image: 'pgvector/pgvector:pg18',
        restartPolicy: 'Always',
        env: [
          { name: 'POSTGRES_USER', value: 'acme' },
          { name: 'POSTGRES_PASSWORD', value: 'acme' },
        ],
        readinessProbe: { exec: { command: ['pg_isready', '-U', 'acme'] } },
      },
      {
        name: 'redis',
        image: 'redis:7-alpine',
        restartPolicy: 'Always',
        env: undefined,
        readinessProbe: { tcpSocket: { port: 6379 } },
      },
    ]);
  });

  it('sets serviceAccountName when provided', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        serviceAccountName: 'engine-platform-agent',
      },
      paths,
    );

    expect(job.spec?.template?.spec?.serviceAccountName).toBe('engine-platform-agent');
  });

  it('omits serviceAccountName when not provided (devCycle Jobs are unaffected)', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );

    expect(job.spec?.template?.spec?.serviceAccountName).toBeUndefined();
  });

  it('appends additionalSecretNames to envFrom alongside authSecretName', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        authSecretName: 'claude-credentials',
        additionalSecretNames: ['platform-agent-credentials'],
      },
      paths,
    );

    expect(job.spec?.template?.spec?.containers?.[0].envFrom).toEqual([
      { secretRef: { name: 'claude-credentials' } },
      { secretRef: { name: 'platform-agent-credentials' } },
    ]);
  });

  it('sets pod template labels when podLabels is provided', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      {
        namespace: 'dev-agents',
        workspacePvcName: 'workspace-tasks',
        workspaceMountPath: '/workspace/tasks',
        podLabels: { 'agentops/role': 'platform-agent' },
      },
      paths,
    );

    expect(job.spec?.template?.metadata?.labels).toEqual({ 'agentops/role': 'platform-agent' });
  });

  it('omits pod template labels when podLabels is not provided', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );

    expect(job.spec?.template?.metadata?.labels).toBeUndefined();
  });

  it('preserves the real CLI exit code and mirrors stdout/stderr into the artifact files via the FIFO/tee script', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-shell-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.promptFile, 'irrelevant', 'utf8');

    const fixturePath = path.join(workspaceRef, 'fake-cli.sh');
    await writeFile(fixturePath, '#!/bin/sh\necho "$1"\necho "$2" >&2\nexit "$3"\n', { mode: 0o755 });

    const fakeSpec: CliSpec = {
      image: 'ghcr.io/example/fake:abc',
      binary: fixturePath,
      buildArgs: () => ['stdout-line', 'stderr-line', '7'],
      parseOutput: () => {
        throw new Error('not used in this test');
      },
      isAuthError: () => false,
    };

    const job = buildAgentJob(
      req,
      fakeSpec,
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );
    const [command, ...args] = job.spec?.template?.spec?.containers?.[0].command ?? [];
    if (!command) throw new Error('buildAgentJob did not produce a container command');

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, PROMPT_FILE: paths.promptFile, OUT_FILE: paths.outFile, ERR_FILE: paths.errFile },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        expect(stdout).toBe('stdout-line\n');
        expect(stderr).toBe('stderr-line\n');
        resolve(code ?? -1);
      });
    });

    expect(exitCode).toBe(7);
    expect(await readFile(paths.outFile, 'utf8')).toBe('stdout-line\n');
    expect(await readFile(paths.errFile, 'utf8')).toBe('stderr-line\n');
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
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
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

  it('heartbeats with job-created/polling phase and the last-known Job status', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-heartbeat-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    const heartbeats: unknown[] = [];
    const now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      now: () => now,
      heartbeat: (details) => heartbeats.push(details),
    });

    const runPromise = runner.run(req);
    const jobName = k8sJobName(req);

    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThanOrEqual(2));
    expect(heartbeats[0]).toEqual({
      phase: 'job-created',
      jobName,
      taskId: 'task-1',
      stage: 'implement',
      elapsedMs: 0,
      idleMs: 0,
      timeoutMs: 30_000,
      outputBytes: 0,
      errorBytes: 0,
      jobStatus: undefined,
    });
    expect(heartbeats[1]).toEqual({
      phase: 'polling',
      jobName,
      taskId: 'task-1',
      stage: 'implement',
      elapsedMs: 0,
      idleMs: 0,
      timeoutMs: 30_000,
      outputBytes: 0,
      errorBytes: 0,
      jobStatus: { active: 1 },
    });

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

    await expect(runPromise).resolves.toEqual({
      output: 'done',
      tokensIn: 3,
      tokensOut: 4,
      wallMs: 50,
    });
  });

  it('retries the status poll after a client-side timeout instead of freezing the whole activity', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-poll-timeout-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new HangThenRealBatchApi(2);
    const heartbeats: unknown[] = [];
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      statusPollTimeoutMs: 5,
      heartbeat: (details) => heartbeats.push(details),
    });

    const runPromise = runner.run(req);
    await vi.waitFor(() => expect(batchApi.creates).toHaveLength(1));

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
    batchApi.setJobStatus(k8sJobName(req), { succeeded: 1 });

    // Proves the loop survived two hung status reads: it still resolved
    // instead of hanging until an outer heartbeat timeout, and it kept
    // heartbeating throughout (a bare Promise.race with no cancellation
    // would leave the loop stuck awaiting the first hung call forever).
    await expect(runPromise).resolves.toEqual({
      output: 'done',
      tokensIn: 3,
      tokensOut: 4,
      wallMs: 50,
    });
    // Two hung status reads plus one successful completion = 3 heartbeats minimum.
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
  });

  it('deletes the Job and rethrows when heartbeat fails (cancellation)', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-cancel-'));
    const req = { ...baseRequest, workspaceRef };
    const batchApi = new FakeBatchApi();
    const cancelError = new Error('activity cancelled');

    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
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

  it('reuses an already-existing Job instead of failing when create is retried after a prior attempt succeeded', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-conflict-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    const opts = { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' };
    // Simulates a previous Temporal retry of this same activity call: its createNamespacedJob
    // already succeeded, but the runner never reached this point (e.g. the status read that follows
    // failed for an unrelated reason). The Job is still sitting in the cluster under this same name.
    await batchApi.createNamespacedJob('dev-agents', buildAgentJob(req, createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), opts, paths));

    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      ...opts,
      batchApi,
      pollIntervalMs: 1,
      heartbeat: () => {},
    });

    const runPromise = runner.run(req);
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
    batchApi.setJobStatus(k8sJobName(req), { succeeded: 1 });

    await expect(runPromise).resolves.toEqual({
      output: 'done',
      tokensIn: 3,
      tokensOut: 4,
      wallMs: 50,
    });
  });

  it('deletes the Job and clears its output files when the terminal output is unparseable, so a retry starts fresh', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-unparseable-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      heartbeat: () => {},
    });

    const runPromise = runner.run(req);
    await vi.waitFor(() => expect(batchApi.creates).toHaveLength(1));

    // A stream the CLI never finished (killed mid-run): events but no terminal
    // `result` event, so parseOutput can't produce a result.
    await writeFile(paths.outFile, '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{}}', 'utf8');
    batchApi.setJobStatus(k8sJobName(req), { failed: 1 });

    await expect(runPromise).rejects.toThrow(ProcessCliProcessError);
    // The failed Job is deleted (so the retry's create won't 409-reuse it) and
    // the stale output file is gone (so the retry can't re-read it and re-fail).
    expect(batchApi.deletes.map((d) => d.name)).toContain(k8sJobName(req));
    expect(existsSync(paths.outFile)).toBe(false);
  });

  it('throws ProcessCliAuthError when stderr matches the auth pattern', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-auth-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
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

  it('kills the Job and throws when output goes idle, even though the Job status stays active', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-idle-'));
    const req = {
      ...baseRequest,
      workspaceRef,
      limits: { maxTokens: 1000, idleTimeoutMs: 100, timeoutMs: 100_000 },
    };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    let now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
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
    batchApi.setJobStatus(k8sJobName(req), { active: 1 });

    // No output is ever written -- simulates a Job whose pod is healthy
    // but whose CLI process has genuinely gone silent.
    now += 150;

    await expect(runPromise).rejects.toThrow(/produced no output for 100ms/);
    expect(batchApi.deletes).toHaveLength(1);
  });

  it('kills the Job and throws when the overall backstop is exceeded despite ongoing output', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-backstop-'));
    const req = {
      ...baseRequest,
      workspaceRef,
      // idleTimeoutMs set impossibly high so only the backstop check can fire.
      limits: { maxTokens: 1000, idleTimeoutMs: 1_000_000, timeoutMs: 100 },
    };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    let now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
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
    await writeFile(paths.outFile, '{"type":"message_start"}\n', 'utf8');

    now += 150; // exceeds timeoutMs (100ms) even though output just grew

    await expect(runPromise).rejects.toThrow(/exceeded overall 100ms budget despite ongoing output/);
    expect(batchApi.deletes).toHaveLength(1);
  });
});
