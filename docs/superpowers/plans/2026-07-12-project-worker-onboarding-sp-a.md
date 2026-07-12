# Per-project worker onboarding — SP-a (chart + ApplicationSet) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a generic `project-worker` Helm chart (OCI-published by engine CI) plus a single ArgoCD `ApplicationSet` so a Tier-2 project worker is deployed by listing it, instead of hand-authoring a per-project ArgoCD Application in the platform repo.

**Architecture:** A new engine-repo chart `charts/project-worker/` renders one worker Deployment + ServiceAccount from a small value set (project, image, task queue, Temporal/OTel connection, external-secret refs) — mounting **no engine credentials**. Engine CI OCI-publishes it alongside `charts/engine`. In `agentops-platform`, one `ApplicationSet` with a git-file generator reads a `workers.yaml` list and deploys the chart per entry. Stage-1 projects set an explicit `taskQueue` in `agents.json` (already supported since SP2), so this SP needs **no engine/control TypeScript code** — the `proj-<project>` default and the repo-sourced generator are SP-b.

**Tech Stack:** Helm 4, ArgoCD ApplicationSet (git-file generator), GitHub Actions (self-hosted runners), OCI chart registry (`oci://gitactions.est1908.top/agentic-ops`), bash + python (the platform tag-bump script).

**Spec:** `docs/superpowers/specs/2026-07-12-project-worker-onboarding-design.md` (§4, §5.1, §10 Stage 1, §12 SP-a, §14 SP-a).

**Two repos, ordered:** Part 1 (Tasks 1–7) lands in **agentops-engine** as one PR and is self-contained/testable (helm lint + golden render + OCI publish). Part 2 (Task 8) lands in **agentops-platform** as a **separate PR**, and can only be applied *after* Part 1 merges and CI publishes the chart (the ApplicationSet pins a published chart version).

---

## File Structure

**agentops-engine (this repo):**
- Create: `charts/project-worker/Chart.yaml` — chart metadata.
- Create: `charts/project-worker/values.yaml` — default values + documentation of each knob.
- Create: `charts/project-worker/templates/serviceaccount.yaml` — the worker's ServiceAccount (no RBAC).
- Create: `charts/project-worker/templates/deployment.yaml` — the worker Deployment (env, image, queue, external secrets).
- Create: `charts/project-worker/tests/run.sh` — golden render check (mirrors `charts/engine/tests/run.sh`).
- Create: `charts/project-worker/tests/render.golden.yaml` — captured expected render.
- Modify: `.github/workflows/ci.yaml` — lint+golden the new chart (`build` job); package+push it (`build-engine-images` job).
- Modify: `scripts/bump-platform-engine-tags.sh` — also re-pin the ApplicationSet's `project-worker` chart version (guarded on the file existing).
- Create: `docs/project-worker-deployment.md` — the onboarding reference.
- Modify: `examples/project-worker/README.md` — point at the onboarding doc.

**agentops-platform (separate repo, Task 8):**
- Create: `clusters/ops/project-workers/applicationset.yaml` — the ApplicationSet.
- Create: `clusters/ops/project-workers/workers.yaml` — the Stage-1 worker list.
- Modify: `clusters/ops/kustomization.yaml` — register the ApplicationSet.

---

## Part 1 — agentops-engine (one PR)

### Task 1: Chart skeleton (`Chart.yaml` + `values.yaml`)

**Files:**
- Create: `charts/project-worker/Chart.yaml`
- Create: `charts/project-worker/values.yaml`

- [ ] **Step 1: Write `charts/project-worker/Chart.yaml`**

```yaml
apiVersion: v2
name: project-worker
description: Generic Tier-2 per-project agentops worker Deployment
version: 0.1.0
appVersion: "0.1.0"
```

- [ ] **Step 2: Write `charts/project-worker/values.yaml`**

```yaml
# Identity of the project this worker serves. Drives resource names and the
# default task queue (proj-<project>). Required.
project: ""

# The PROJECT-BUILT worker image ref (repo:tag or repo@digest). Set per release
# by the project's own CI. Required.
image: ""

# Queue this worker polls. Empty -> defaults to proj-<project> in the template.
# Must match the taskQueue the project's agents.json schedules onto (spec §7).
taskQueue: ""

replicas: 1

# Temporal connection. This is the SHARED namespace the engine uses (spec §3/§9);
# supplied by the platform ApplicationSet from cluster-wide values, not per project.
temporal:
  address: ""
  namespace: ""

# OTLP endpoint for the worker's own orchestration spans (shared platform value).
otel:
  endpoint: ""

# K8s Secret names holding the project's OWN externals (e.g. a Rollbar token),
# mounted as envFrom. NEVER engine credentials (spec §4.1).
externalSecretRefs: []

# Shared registry pull secret.
imagePullSecretName: registry-credentials
pullPolicy: IfNotPresent

# K8s namespace the worker runs in — shared with the engine (spec §9).
namespace: dev-agents

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: "1"
    memory: 512Mi
```

- [ ] **Step 3: Verify the chart lints**

Run: `helm lint charts/project-worker`
Expected: `1 chart(s) linted, 0 chart(s) failed` (an `[INFO]` about no icon is fine).

- [ ] **Step 4: Commit**

```bash
git add charts/project-worker/Chart.yaml charts/project-worker/values.yaml
git commit -m "feat(chart): project-worker chart skeleton"
```

---

### Task 2: Worker Deployment + ServiceAccount templates

**Files:**
- Create: `charts/project-worker/templates/serviceaccount.yaml`
- Create: `charts/project-worker/templates/deployment.yaml`

- [ ] **Step 1: Write `charts/project-worker/templates/serviceaccount.yaml`**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Values.project }}-worker
  namespace: {{ .Values.namespace }}
```

- [ ] **Step 2: Write `charts/project-worker/templates/deployment.yaml`**

Note the `$queue` helper: `taskQueue` defaults to `proj-<project>` when empty. The worker entrypoint reads `PROJECT_TASK_QUEUE` (see `examples/project-worker/agentops/worker.ts`). The pod mounts **no** engine secrets, **no** namespace-create job, **no** search-attribute registration — those are engine responsibilities (spec §4.1).

```yaml
{{- $queue := .Values.taskQueue | default (printf "proj-%s" .Values.project) -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.project }}-worker
  namespace: {{ .Values.namespace }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      app: {{ .Values.project }}-worker
  template:
    metadata:
      labels:
        app: {{ .Values.project }}-worker
    spec:
      serviceAccountName: {{ .Values.project }}-worker
      imagePullSecrets:
        - name: {{ .Values.imagePullSecretName }}
      containers:
        - name: worker
          image: {{ .Values.image | quote }}
          imagePullPolicy: {{ .Values.pullPolicy }}
          env:
            - name: TEMPORAL_ADDRESS
              value: {{ .Values.temporal.address | quote }}
            - name: TEMPORAL_NAMESPACE
              value: {{ .Values.temporal.namespace | quote }}
            - name: PROJECT_TASK_QUEUE
              value: {{ $queue | quote }}
            {{- if .Values.otel.endpoint }}
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: {{ .Values.otel.endpoint | quote }}
            {{- end }}
          {{- if .Values.externalSecretRefs }}
          envFrom:
            {{- range .Values.externalSecretRefs }}
            - secretRef:
                name: {{ . | quote }}
            {{- end }}
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

- [ ] **Step 3: Render and eyeball the output**

Run:
```bash
helm template broccoli charts/project-worker --namespace dev-agents \
  --set project=broccoli \
  --set image=gitactions.est1908.top/broccoli/agentops-worker:testsha \
  --set temporal.address=temporal-frontend.platform.svc.cluster.local:7233 \
  --set temporal.namespace=dev-agents \
  --set otel.endpoint=http://alloy.platform.svc.cluster.local:4317 \
  --set 'externalSecretRefs={rollbar-token}'
```
Expected: a `ServiceAccount` `broccoli-worker` and a `Deployment` `broccoli-worker` whose container has `PROJECT_TASK_QUEUE=proj-broccoli`, `image: "...:testsha"`, an `envFrom` secretRef `rollbar-token`, and **no** other env/secret mounts.

- [ ] **Step 4: Verify the queue default with taskQueue omitted**

Run the same command **without** `--set taskQueue` and confirm `PROJECT_TASK_QUEUE` is `proj-broccoli`; then run with `--set taskQueue=proj-custom` and confirm it becomes `proj-custom`.
Expected: default `proj-broccoli`; override respected.

- [ ] **Step 5: Commit**

```bash
git add charts/project-worker/templates/serviceaccount.yaml charts/project-worker/templates/deployment.yaml
git commit -m "feat(chart): project-worker Deployment + ServiceAccount"
```

---

### Task 3: Golden render test + CI lint/test wiring

**Files:**
- Create: `charts/project-worker/tests/run.sh`
- Create: `charts/project-worker/tests/render.golden.yaml`
- Modify: `.github/workflows/ci.yaml` (the `build` job, after the engine-chart lint/test lines)

- [ ] **Step 1: Write `charts/project-worker/tests/run.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
diff <(helm template broccoli . --namespace dev-agents \
  --set project=broccoli \
  --set image=gitactions.est1908.top/broccoli/agentops-worker:testsha \
  --set temporal.address=temporal-frontend.platform.svc.cluster.local:7233 \
  --set temporal.namespace=dev-agents \
  --set otel.endpoint=http://alloy.platform.svc.cluster.local:4317 \
  --set 'externalSecretRefs={rollbar-token}') tests/render.golden.yaml
```

- [ ] **Step 2: Generate the golden file from the current render**

Run:
```bash
chmod +x charts/project-worker/tests/run.sh
helm template broccoli charts/project-worker --namespace dev-agents \
  --set project=broccoli \
  --set image=gitactions.est1908.top/broccoli/agentops-worker:testsha \
  --set temporal.address=temporal-frontend.platform.svc.cluster.local:7233 \
  --set temporal.namespace=dev-agents \
  --set otel.endpoint=http://alloy.platform.svc.cluster.local:4317 \
  --set 'externalSecretRefs={rollbar-token}' > charts/project-worker/tests/render.golden.yaml
```

- [ ] **Step 3: Run the golden test to verify it passes**

Run: `bash charts/project-worker/tests/run.sh`
Expected: no output, exit 0 (the render matches the golden).

- [ ] **Step 4: Wire the chart into CI**

In `.github/workflows/ci.yaml`, find (in the `build` job):
```yaml
      - run: helm lint charts/engine

      - run: bash charts/engine/tests/run.sh
```
and add immediately after:
```yaml
      - run: helm lint charts/project-worker

      - run: bash charts/project-worker/tests/run.sh
```

- [ ] **Step 5: Commit**

```bash
git add charts/project-worker/tests/run.sh charts/project-worker/tests/render.golden.yaml .github/workflows/ci.yaml
git commit -m "test(chart): golden render for project-worker + CI lint/test"
```

---

### Task 4: OCI-publish the chart in CI

**Files:**
- Modify: `.github/workflows/ci.yaml` (the `build-engine-images` job, after the engine chart push)

- [ ] **Step 1: Add the package+push step**

In `.github/workflows/ci.yaml`, find the engine chart publish block ending with:
```yaml
          helm push "/tmp/chart/engine-0.0.0-${{ github.sha }}.tgz" \
            oci://gitactions.est1908.top/agentic-ops
```
and append, inside the **same** `run:` script (same indentation, immediately after that `helm push`):
```yaml
          helm package charts/project-worker \
            --version "0.0.0-${{ github.sha }}" \
            --app-version "${{ github.sha }}" \
            --destination /tmp/chart
          helm push "/tmp/chart/project-worker-0.0.0-${{ github.sha }}.tgz" \
            oci://gitactions.est1908.top/agentic-ops
```

- [ ] **Step 2: Verify the packaged filename locally**

Run:
```bash
helm package charts/project-worker --version "0.0.0-testsha" --app-version "testsha" --destination /tmp/chart-check
ls /tmp/chart-check
```
Expected: `project-worker-0.0.0-testsha.tgz` exists — confirming the `helm push` filename in Step 1 is correct.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: OCI-publish the project-worker chart"
```

---

### Task 5: Extend the platform tag-bump script

The ApplicationSet (Task 8) pins the `project-worker` chart at `0.0.0-<engine-sha>`. Engine CI already bumps the engine chart pin via `scripts/bump-platform-engine-tags.sh`; extend it to also re-pin the ApplicationSet, guarded so it is inert until Task 8's file exists.

**Files:**
- Modify: `scripts/bump-platform-engine-tags.sh`

- [ ] **Step 1: Add the ApplicationSet re-pin to the python heredoc**

In `scripts/bump-platform-engine-tags.sh`, find the end of the python block (just before the closing `PY`):
```python
if n != 1:
    raise SystemExit("expected exactly one engine chart targetRevision to update")
app.write_text(app_text)
PY
```
and insert, **between** `app.write_text(app_text)` and `PY`:
```python

# project-worker ApplicationSet chart pin (docs/superpowers/specs/2026-07-12-
# project-worker-onboarding-design.md SP-a). Guarded: inert until the platform
# ApplicationSet exists, so this is safe to land in the engine repo first.
appset = pathlib.Path("clusters/ops/project-workers/applicationset.yaml")
if appset.exists():
    appset_text = appset.read_text()
    appset_text, m = re.subn(
        r"(repoURL: oci://gitactions\.est1908\.top/agentic-ops/project-worker\n\s*chart: project-worker\n\s*targetRevision:\s*).*$",
        rf'\g<1>"0.0.0-{sha}"',
        appset_text,
        count=1,
        flags=re.M,
    )
    if m != 1:
        raise SystemExit("expected exactly one project-worker chart targetRevision to update")
    appset.write_text(appset_text)
```

- [ ] **Step 2: Update the final `git add` line**

Find:
```bash
git add clusters/ops/engine/values.yaml clusters/ops/engine/application.yaml
```
and replace with:
```bash
git add clusters/ops/engine/values.yaml clusters/ops/engine/application.yaml clusters/ops/project-workers/applicationset.yaml
```
(`git add` on a path that doesn't exist yet is a no-op with a warning, not a failure; once Task 8 lands, the re-pin is picked up.)

- [ ] **Step 3: Verify the new regex against a sample (no platform checkout needed)**

Run:
```bash
python3 - <<'PY'
import re
sha = "abc123"
sample = '''      source:
        repoURL: oci://gitactions.est1908.top/agentic-ops/project-worker
        chart: project-worker
        targetRevision: "0.0.0-oldsha"
'''
out, m = re.subn(
    r"(repoURL: oci://gitactions\.est1908\.top/agentic-ops/project-worker\n\s*chart: project-worker\n\s*targetRevision:\s*).*$",
    rf'\g<1>"0.0.0-{sha}"', sample, count=1, flags=re.M)
assert m == 1, m
assert '0.0.0-abc123' in out, out
print("OK\n" + out)
PY
```
Expected: prints `OK` and the sample with `targetRevision: "0.0.0-abc123"`.

- [ ] **Step 4: Commit**

```bash
git add scripts/bump-platform-engine-tags.sh
git commit -m "ci: bump the project-worker ApplicationSet chart pin from engine CI"
```

---

### Task 6: Onboarding docs

**Files:**
- Create: `docs/project-worker-deployment.md`
- Modify: `examples/project-worker/README.md`

- [ ] **Step 1: Write `docs/project-worker-deployment.md`**

```markdown
# Deploying a Tier-2 project worker

A Tier-2 project (a custom Temporal workflow shape, e.g. a Rollbar monitor) runs
in its **own worker** that polls its own task queue and delegates privileged work
back to the engine (see `docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp2-design.md`).
This doc covers **deploying** that worker.

## Model (why there's no per-project ArgoCD Application to hand-write)

- The worker is deployed by the generic `project-worker` Helm chart
  (`oci://gitactions.est1908.top/agentic-ops/project-worker`), rendered per project
  by one ArgoCD `ApplicationSet` in `agentops-platform`
  (`clusters/ops/project-workers/`).
- Temporal is a single shared namespace; the worker "registers" simply by polling
  its task queue `proj-<project>`. The engine reconciler starts the project's
  workflow **by name on that queue**; the worker (the only process polling it) runs it.

## Onboarding (Stage 1 — git-file list)

1. Your CI builds and pushes your worker image (`worker.ts` using
   `@agentic-ops/engine-sdk/worker`; see `examples/project-worker/`).
2. In `agentops-platform`, add an entry to `clusters/ops/project-workers/workers.yaml`:
   ```yaml
   - project: <slug>
     image: <registry>/<repo>/agentops-worker:<tag>
     # taskQueue omitted -> proj-<slug>
   ```
3. Merge the platform PR -> ArgoCD syncs -> your worker Deployment polls `proj-<slug>`.
4. In your repo, `agents.json` schedules your workflow with an explicit
   `"taskQueue": "proj-<slug>"` (the queue your worker polls). ConfigSync starts it there.

## What the worker pod gets — and does NOT get

- **Gets:** Temporal connection (the shared namespace), `PROJECT_TASK_QUEUE`, the
  OTLP endpoint, and any `externalSecretRefs` you declare (your own externals,
  provisioned as SOPS secrets in `agentops-platform`).
- **Does NOT get:** any engine credential (agent OAuth, per-project SCM tokens).
  Privileged work is delegated to the engine via `engineActivities()` /
  `childDevCycle()` — that omission is the security boundary.

> Stage 2 (repo-sourced onboarding — set the worker in your `agents.json`, no
> platform PR) is tracked separately (spec §12 SP-b).
```

- [ ] **Step 2: Point the example README at the doc**

In `examples/project-worker/README.md`, find:
```markdown
See docs/authoring-project-workflows.md
```
and add on the next line:
```markdown
To deploy this worker, see docs/project-worker-deployment.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/project-worker-deployment.md examples/project-worker/README.md
git commit -m "docs: project-worker deployment/onboarding guide"
```

---

### Task 7: Ship the engine-repo change (PR + CI + Bugbot)

REQUIRED SUB-SKILL: use the `shipping-changes` skill.

- [ ] **Step 1: Sync main and rebase the branch**

```bash
git fetch origin
git rebase origin/main
```

- [ ] **Step 2: Run the full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && helm lint charts/project-worker && bash charts/project-worker/tests/run.sh`
Expected: all green (no TS changed in this SP, but the repo gate must pass; the chart lint + golden must pass).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: project-worker chart + OCI publish (SP-a)" \
  --body "SP-a of docs/superpowers/specs/2026-07-12-project-worker-onboarding-design.md: generic project-worker Helm chart, golden render test, CI OCI-publish, and the platform tag-bump re-pin (inert until the ApplicationSet lands). Platform ApplicationSet is a follow-on PR in agentops-platform (Task 8)."
```

- [ ] **Step 4: Get CI green**

Watch: `gh pr checks --watch`
Expected: all checks pass (including the new `helm lint`/golden step and the chart publish on the merge build). Fix any failure and push.

- [ ] **Step 5: Resolve the automated review**

Per `shipping-changes`: wait for and address the automated review. (Note: Bugbot is inactive on agentops-engine — if no review appears, do not block on it.)

- [ ] **Step 6: Merge**

```bash
gh pr merge --squash --delete-branch
```

After merge, confirm engine CI published the chart:
```bash
helm show chart oci://gitactions.est1908.top/agentic-ops/project-worker --version "0.0.0-$(git rev-parse origin/main)"
```
Expected: chart metadata prints — the version pin Task 8 will use.

---

## Part 2 — agentops-platform (separate PR, after Part 1 merges)

### Task 8: ApplicationSet + workers.yaml + kustomization registration

**Repo:** `agentops-platform` (clone/checkout separately). **Prerequisite:** Part 1 merged and its chart published (Task 7 Step 6).

**Files:**
- Create: `clusters/ops/project-workers/applicationset.yaml`
- Create: `clusters/ops/project-workers/workers.yaml`
- Modify: `clusters/ops/kustomization.yaml`

- [ ] **Step 1: Determine the published chart version**

In the `agentops-engine` checkout: `git rev-parse origin/main` — call it `<ENGINE_SHA>`. The chart version is `0.0.0-<ENGINE_SHA>`.

- [ ] **Step 2: Write `clusters/ops/project-workers/applicationset.yaml`**

Replace `<ENGINE_SHA>` with the value from Step 1. (After the next engine merge, `bump-platform-engine-tags.sh` re-pins this automatically — Task 5.)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: project-workers
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - git:
        repoURL: https://github.com/est1908-agentic-ops/agentops-platform.git
        revision: main
        files:
          - path: clusters/ops/project-workers/workers.yaml
  template:
    metadata:
      name: 'project-worker-{{.project}}'
      namespace: argocd
    spec:
      project: default
      source:
        repoURL: oci://gitactions.est1908.top/agentic-ops/project-worker
        chart: project-worker
        targetRevision: "0.0.0-<ENGINE_SHA>"
        helm:
          releaseName: '{{.project}}'
          valuesObject:
            project: '{{.project}}'
            image: '{{.image}}'
            taskQueue: '{{.taskQueue}}'
            temporal:
              address: temporal-frontend.platform.svc.cluster.local:7233
              namespace: dev-agents
            otel:
              endpoint: http://alloy.platform.svc.cluster.local:4317
      destination:
        server: https://kubernetes.default.svc
        namespace: dev-agents
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

Notes: `goTemplate: true` is required for the `{{.field}}` element substitution. `taskQueue` is optional in `workers.yaml`; when absent it renders empty and the chart defaults it to `proj-<project>` (Task 2's `$queue` helper). `missingkey=error` is intentionally NOT set, so an omitted `taskQueue` renders as empty rather than erroring.

- [ ] **Step 3: Write `clusters/ops/project-workers/workers.yaml` (bootstrap: broccoli)**

Use the real broccoli worker image tag its CI produced.

```yaml
- project: broccoli
  image: gitactions.est1908.top/broccoli/agentops-worker:<tag>
  # taskQueue omitted -> proj-broccoli
```

- [ ] **Step 4: Register the ApplicationSet in the root kustomization**

In `clusters/ops/kustomization.yaml`, find the `resources:` list ending with:
```yaml
  - engine-secrets/application.yaml
  - engine/application.yaml
```
and append:
```yaml
  - project-workers/applicationset.yaml
```

- [ ] **Step 5: Validate the manifests render**

Run (in the platform checkout):
```bash
kubectl kustomize clusters/ops >/dev/null && echo "kustomize OK"
```
Expected: `kustomize OK` (the ApplicationSet is included and parses). If `kubectl` isn't available, use `kustomize build clusters/ops >/dev/null`.

- [ ] **Step 6: Open the platform PR and merge**

```bash
git checkout -b feat/project-worker-appset
git add clusters/ops/project-workers/ clusters/ops/kustomization.yaml
git commit -m "feat: project-workers ApplicationSet + broccoli worker"
git push -u origin HEAD
gh pr create --repo est1908-agentic-ops/agentops-platform \
  --title "feat: project-workers ApplicationSet (SP-a)" \
  --body "Deploys Tier-2 workers via one ApplicationSet reading workers.yaml. Chart from agentops-engine SP-a. Bootstraps broccoli."
```
After merge, verify ArgoCD created the Application and the worker is running:
```bash
kubectl get applications.argoproj.io -n argocd | grep project-worker-broccoli
kubectl -n dev-agents get deploy broccoli-worker
kubectl -n dev-agents logs deploy/broccoli-worker --tail=20
```
Expected: the `project-worker-broccoli` Application is `Synced/Healthy`; the `broccoli-worker` Deployment is ready; its logs show the worker connected and polling `proj-broccoli`.

---

## Self-Review

**Spec coverage (SP-a rows of §12/§14):**
- Generic chart rendering Deployment + SA, queue default, mounted externals, no engine secrets/namespace-job/SA-registration → Tasks 1–2, golden test Task 3. ✓
- Engine CI OCI-publishes + version bump → Task 4; ApplicationSet re-pin → Task 5. ✓
- Platform ApplicationSet (git-file generator) + workers.yaml + kustomization + broccoli end-to-end → Task 8. ✓
- `examples/project-worker/` onboarding note → Task 6. ✓
- Green bar / ship → Task 7. ✓
- (Deliberately deferred to SP-b, not gaps: the `worker` block schema, the `control` generator endpoint, the `proj-<project>` *reconciler* default + safety warning, Mission Control.)

**Placeholder scan:** `<tag>` (workers.yaml image), `<ENGINE_SHA>` (chart pin) are real runtime values the executor substitutes from the named prior step — each has an explicit derivation step (Task 8 Step 1/3). No TBD/TODO.

**Type/name consistency:** value keys (`project`, `image`, `taskQueue`, `temporal.address`, `temporal.namespace`, `otel.endpoint`, `externalSecretRefs`, `namespace`, `imagePullSecretName`, `pullPolicy`, `resources`) are identical across `values.yaml` (Task 1), the templates (Task 2), the golden `--set` flags (Task 3), and the ApplicationSet `valuesObject` (Task 8). Env var `PROJECT_TASK_QUEUE` matches `examples/project-worker/agentops/worker.ts`. Chart name `project-worker` and OCI path are identical across Tasks 4, 5, 8.

**Shipping task:** Task 7 is the PR/CI/review shipping task for the engine repo (via `shipping-changes`); Task 8 ships the platform repo as its own PR.
