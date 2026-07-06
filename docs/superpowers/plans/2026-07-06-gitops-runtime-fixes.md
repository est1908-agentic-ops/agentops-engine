# GitOps Runtime Fixes for charts/engine + Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine deployable under GitOps on k3s with zero live patches: fix the two `CreateContainerConfigError` blockers (worker Deployment pod + `agent-claude` K8s Job pods lack a numeric `runAsUser`), make `GITHUB_TOKEN` optional, and confirm the already-merged whole-secret `envFrom` wiring satisfies the z.ai/Anthropic-compatible-provider requirement.

**Architecture:** All fixes live in this repo (`agentops-engine`), since the chart is consumed by `agentops-platform` as opaque template+values — no platform-side overrides are possible. Numeric UIDs become chart values with defaults (`runAsUser: 1000`, matching the `node` user baked into both `images/worker/Dockerfile` and `images/agent-claude/Dockerfile`), threaded through to the runtime-built Job pod spec via a new env var + `K8sJobRunnerOptions.runAsUser`. `GITHUB_TOKEN` becomes `optional: true` on its `secretKeyRef` so the worker starts without PR-opening credentials.

**Tech Stack:** Helm 3 chart (`charts/engine`), Node 22 + TypeScript (`packages/backends`, `packages/worker`), vitest, `helm template`/`helm lint`.

**Already done, no task needed:** commit `6acc002` (`fix(m2): wire Claude auth secret into K8s Job pods`) already switched the `agent-claude` Job container to `envFrom: [{ secretRef: { name: <claudeAuthSecretName> } }]` (`packages/backends/src/k8s/k8s-job-runner.ts:63,95`) and threads `CLAUDE_AUTH_SECRET_NAME` through `packages/worker/src/main.ts:74`. Putting `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` keys in the `claude-credentials` Secret already reaches the Job container with zero further code changes — Task 5 re-confirms this via the full test suite, but item 4 from the spec requires no new code.

---

## File Structure

| File | Responsibility |
|---|---|
| `charts/engine/values.yaml` | Chart defaults: adds `podSecurityContext`, `containerSecurityContext` (worker Deployment), `agentRunnerUid` (Job pods). |
| `charts/engine/templates/deployment.yaml` | Worker Deployment template: renders the new securityContext values, adds `optional: true` to `GITHUB_TOKEN`, adds `AGENT_RUNNER_UID` env var. |
| `charts/engine/tests/render.golden.yaml` | Golden snapshot diffed byte-for-byte by `tests/run.sh` — regenerated after every template/values change. |
| `packages/backends/src/k8s/k8s-types.ts` | `V1Job` type — adds `runAsUser?: number` to both securityContext shapes. |
| `packages/backends/src/k8s/k8s-job-runner.ts` | `buildAgentJob` — applies a numeric `runAsUser` (default 1000) to the Job's pod- and container-level securityContext. |
| `packages/backends/src/k8s/k8s-job-runner.test.ts` | Covers default and custom `runAsUser`. |
| `packages/worker/src/main.ts` | `buildBackends` — reads `AGENT_RUNNER_UID` and passes it as `runAsUser` to `K8sJobRunner`. |

---

### Task 1: Configurable, non-root-safe securityContext for the worker Deployment

**Files:**
- Modify: `charts/engine/values.yaml`
- Modify: `charts/engine/templates/deployment.yaml`
- Modify: `charts/engine/tests/render.golden.yaml`

- [ ] **Step 1: Add the new values**

Edit `charts/engine/values.yaml`, inserting after the `taskQueue: agentops-devcycle` line:

```yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000

containerSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
```

- [ ] **Step 2: Render the chart template values**

Edit `charts/engine/templates/deployment.yaml`. Replace:

```yaml
      serviceAccountName: {{ .Release.Name }}-worker
      securityContext:
        runAsNonRoot: true
      containers:
        - name: worker
          image: "{{ .Values.image.repository }}/worker:{{ .Values.image.workerTag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          env:
```

with:

```yaml
      serviceAccountName: {{ .Release.Name }}-worker
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: worker
          image: "{{ .Values.image.repository }}/worker:{{ .Values.image.workerTag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext:
            {{- toYaml .Values.containerSecurityContext | nindent 12 }}
          env:
```

- [ ] **Step 3: Run the chart snapshot test and confirm it FAILS**

```bash
bash charts/engine/tests/run.sh
```

Expected: non-empty `diff` output (golden file is now stale) and non-zero exit.

- [ ] **Step 4: Regenerate the golden snapshot**

```bash
(cd charts/engine && helm template engine . --namespace dev-agents > tests/render.golden.yaml)
```

- [ ] **Step 5: Re-run the snapshot test and confirm it PASSES**

```bash
bash charts/engine/tests/run.sh
```

Expected: no output, exit code 0.

- [ ] **Step 6: Lint the chart**

```bash
helm lint charts/engine
```

Expected: `1 chart(s) linted, 0 chart(s) failed`.

- [ ] **Step 7: Commit**

```bash
git add charts/engine/values.yaml charts/engine/templates/deployment.yaml charts/engine/tests/render.golden.yaml
git commit -m "fix(chart): set numeric runAsUser on worker pod/container securityContext"
```

---

### Task 2: Make GITHUB_TOKEN optional on the worker Deployment

**Files:**
- Modify: `charts/engine/templates/deployment.yaml`
- Modify: `charts/engine/tests/render.golden.yaml`

- [ ] **Step 1: Add `optional: true`**

Edit `charts/engine/templates/deployment.yaml`. Replace:

```yaml
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.githubTokenSecretName }}
                  key: GITHUB_TOKEN
```

with:

```yaml
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.githubTokenSecretName }}
                  key: GITHUB_TOKEN
                  optional: true
```

- [ ] **Step 2: Run the chart snapshot test and confirm it FAILS**

```bash
bash charts/engine/tests/run.sh
```

Expected: non-empty diff (golden file lacks the new `optional: true` line).

- [ ] **Step 3: Regenerate the golden snapshot**

```bash
(cd charts/engine && helm template engine . --namespace dev-agents > tests/render.golden.yaml)
```

- [ ] **Step 4: Re-run the snapshot test and confirm it PASSES**

```bash
bash charts/engine/tests/run.sh
```

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add charts/engine/templates/deployment.yaml charts/engine/tests/render.golden.yaml
git commit -m "fix(chart): make GITHUB_TOKEN optional so the worker starts without PR credentials"
```

---

### Task 3: Numeric runAsUser on agent-claude K8s Job pods

**Files:**
- Modify: `packages/backends/src/k8s/k8s-types.ts`
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Test: `packages/backends/src/k8s/k8s-job-runner.test.ts`

- [ ] **Step 1: Write the failing tests first**

Edit `packages/backends/src/k8s/k8s-job-runner.test.ts`. In the `buildAgentJob` describe block, replace the tail of the first test (the `securityContext`/`envFrom` assertions):

```ts
    expect(container?.securityContext).toEqual({ runAsNonRoot: true, allowPrivilegeEscalation: false });
    expect(container?.envFrom).toBeUndefined();
```

with:

```ts
    expect(job.spec?.template?.spec?.securityContext).toEqual({ runAsNonRoot: true, runAsUser: 1000 });
    expect(container?.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      allowPrivilegeEscalation: false,
    });
    expect(container?.envFrom).toBeUndefined();
```

Then add a new test directly after the `'wires envFrom from authSecretName when provided'` test (still inside the `buildAgentJob` describe block, before its closing `});`):

```ts

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
```

- [ ] **Step 2: Run the tests and confirm they FAIL**

```bash
pnpm test -- k8s-job-runner
```

Expected: the two edited/added assertions fail (`runAsUser` missing/undefined) — current `buildAgentJob` never sets it.

- [ ] **Step 3: Widen the V1Job type**

Edit `packages/backends/src/k8s/k8s-types.ts`. Replace:

```ts
        securityContext?: { runAsNonRoot?: boolean };
```

with:

```ts
        securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
```

Replace:

```ts
          securityContext?: { runAsNonRoot?: boolean; allowPrivilegeEscalation?: boolean };
```

with:

```ts
          securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; allowPrivilegeEscalation?: boolean };
```

- [ ] **Step 4: Implement runAsUser in buildAgentJob**

Edit `packages/backends/src/k8s/k8s-job-runner.ts`. Add `runAsUser?: number;` to the `K8sJobRunnerOptions` interface, right after `authSecretName?: string;`:

```ts
export interface K8sJobRunnerOptions {
  namespace: string;
  workspacePvcName: string;
  workspaceMountPath: string;
  batchApi: BatchV1ApiLike;
  pollIntervalMs?: number;
  authSecretName?: string;
  runAsUser?: number;
  heartbeat?: () => void;
  now?: () => number;
}
```

Replace the `buildAgentJob` function signature and body:

```ts
export function buildAgentJob(
  req: BackendRunRequest,
  spec: CliSpec,
  opts: Pick<K8sJobRunnerOptions, 'namespace' | 'workspacePvcName' | 'workspaceMountPath' | 'authSecretName'>,
  paths: ReturnType<typeof agentOpsArtifactPaths>,
): V1Job {
  const args = spec.buildArgs(req);
  const envFrom = opts.authSecretName ? [{ secretRef: { name: opts.authSecretName } }] : undefined;

  return {
    metadata: {
      name: k8sJobName(req),
      namespace: opts.namespace,
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(req.limits.timeoutMs / 1000),
      template: {
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true },
          volumes: [
            {
              name: 'workspace-tasks',
              persistentVolumeClaim: { claimName: opts.workspacePvcName },
            },
          ],
          containers: [
            {
              name: 'agent',
              image: spec.image,
              workingDir: req.workspaceRef,
              command: ['/bin/sh', '-c', SHELL_REDIRECT, spec.binary, ...args],
              env: [
                { name: 'PROMPT_FILE', value: paths.promptFile },
                { name: 'OUT_FILE', value: paths.outFile },
                { name: 'ERR_FILE', value: paths.errFile },
              ],
              envFrom,
              securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false },
              volumeMounts: [
                {
                  name: 'workspace-tasks',
                  mountPath: opts.workspaceMountPath,
                },
              ],
            },
          ],
        },
      },
    },
  };
}
```

with:

```ts
export function buildAgentJob(
  req: BackendRunRequest,
  spec: CliSpec,
  opts: Pick<
    K8sJobRunnerOptions,
    'namespace' | 'workspacePvcName' | 'workspaceMountPath' | 'authSecretName' | 'runAsUser'
  >,
  paths: ReturnType<typeof agentOpsArtifactPaths>,
): V1Job {
  const args = spec.buildArgs(req);
  const envFrom = opts.authSecretName ? [{ secretRef: { name: opts.authSecretName } }] : undefined;
  const runAsUser = opts.runAsUser ?? 1000;

  return {
    metadata: {
      name: k8sJobName(req),
      namespace: opts.namespace,
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(req.limits.timeoutMs / 1000),
      template: {
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser },
          volumes: [
            {
              name: 'workspace-tasks',
              persistentVolumeClaim: { claimName: opts.workspacePvcName },
            },
          ],
          containers: [
            {
              name: 'agent',
              image: spec.image,
              workingDir: req.workspaceRef,
              command: ['/bin/sh', '-c', SHELL_REDIRECT, spec.binary, ...args],
              env: [
                { name: 'PROMPT_FILE', value: paths.promptFile },
                { name: 'OUT_FILE', value: paths.outFile },
                { name: 'ERR_FILE', value: paths.errFile },
              ],
              envFrom,
              securityContext: { runAsNonRoot: true, runAsUser, allowPrivilegeEscalation: false },
              volumeMounts: [
                {
                  name: 'workspace-tasks',
                  mountPath: opts.workspaceMountPath,
                },
              ],
            },
          ],
        },
      },
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they PASS**

```bash
pnpm test -- k8s-job-runner
```

Expected: all tests in `k8s-job-runner.test.ts` pass.

- [ ] **Step 6: Typecheck the package**

```bash
pnpm --filter @agentops/backends run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/backends/src/k8s/k8s-types.ts packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts
git commit -m "fix(backends): set numeric runAsUser on agent-claude Job pod/container securityContext"
```

---

### Task 4: Wire agentRunnerUid from the chart through to the Job runner

**Files:**
- Modify: `charts/engine/values.yaml`
- Modify: `charts/engine/templates/deployment.yaml`
- Modify: `charts/engine/tests/render.golden.yaml`
- Modify: `packages/worker/src/main.ts`

- [ ] **Step 1: Add the chart value**

Edit `charts/engine/values.yaml`, inserting after the `containerSecurityContext` block added in Task 1:

```yaml
agentRunnerUid: 1000
```

- [ ] **Step 2: Add the env var to the worker Deployment**

Edit `charts/engine/templates/deployment.yaml`. Replace:

```yaml
            - name: AGENT_RUNNER_IMAGE
              value: "{{ .Values.image.repository }}/agent-claude:{{ .Values.image.agentClaudeTag }}"
            - name: GITHUB_TOKEN
```

with:

```yaml
            - name: AGENT_RUNNER_IMAGE
              value: "{{ .Values.image.repository }}/agent-claude:{{ .Values.image.agentClaudeTag }}"
            - name: AGENT_RUNNER_UID
              value: {{ .Values.agentRunnerUid | quote }}
            - name: GITHUB_TOKEN
```

- [ ] **Step 3: Run the chart snapshot test and confirm it FAILS**

```bash
bash charts/engine/tests/run.sh
```

Expected: non-empty diff (golden file lacks the new env var).

- [ ] **Step 4: Regenerate the golden snapshot**

```bash
(cd charts/engine && helm template engine . --namespace dev-agents > tests/render.golden.yaml)
```

- [ ] **Step 5: Re-run the snapshot test and confirm it PASSES**

```bash
bash charts/engine/tests/run.sh
```

Expected: no output, exit code 0.

- [ ] **Step 6: Wire the env var into buildBackends**

Edit `packages/worker/src/main.ts`. Replace:

```ts
    claude: new K8sJobRunner(claudeSpec, {
      namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
      workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
      workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
      authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME,
      batchApi: batchApiFromClient(kc.makeApiClient(BatchV1Api)),
    }),
```

with:

```ts
    claude: new K8sJobRunner(claudeSpec, {
      namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
      workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
      workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
      authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME,
      runAsUser: process.env.AGENT_RUNNER_UID ? Number(process.env.AGENT_RUNNER_UID) : undefined,
      batchApi: batchApiFromClient(kc.makeApiClient(BatchV1Api)),
    }),
```

- [ ] **Step 7: Typecheck the worker package**

```bash
pnpm --filter @agentops/worker run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add charts/engine/values.yaml charts/engine/templates/deployment.yaml charts/engine/tests/render.golden.yaml packages/worker/src/main.ts
git commit -m "feat(chart): thread agentRunnerUid through to the worker's K8sJobRunner"
```

---

### Task 5: Full local verification (matches CI exactly)

**Files:** none (verification only).

- [ ] **Step 1: Run the full CI-equivalent suite**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:policies-coverage
pnpm e2e
helm lint charts/engine
bash charts/engine/tests/run.sh
```

Expected: every command exits 0. This re-runs `k8s-job-runner.test.ts`'s `'wires envFrom from authSecretName when provided'` test, reconfirming the already-merged z.ai/Anthropic-compatible-provider wiring (item 4) still holds with no further changes.

- [ ] **Step 2: Fix any fallout**

If anything fails, diagnose and fix in the relevant task's files (do not skip hooks or weaken assertions to force green), then re-run Step 1's full command list.

- [ ] **Step 3: Note the manual, out-of-session verification**

This session has no `kubectl`/`argocd` CLI or cluster access. Record for the PR description: after merge and once `agentops-platform`'s ArgoCD Application syncs the new chart, manually confirm the `engine-worker` Deployment pod and a triggered `agent-claude` Job pod both reach `Running` (not `CreateContainerConfigError`), and that the platform's `engine` Application shows `Synced`/`Healthy`.

---

### Task 6: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh
```

(resolve conflicts + commit first if any; fix any fallout from the merge)

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "fix(chart,backends): numeric runAsUser + optional GITHUB_TOKEN for GitOps deploy"
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
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh
```
Confirm no unresolved review threads remain, then mark this task complete.
