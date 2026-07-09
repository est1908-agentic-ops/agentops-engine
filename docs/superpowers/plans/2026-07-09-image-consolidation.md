# Engine Dockerfile Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `images/worker/Dockerfile`, `images/gateway/Dockerfile`, `images/control/Dockerfile` with one multi-stage `images/engine/Dockerfile` (shared `base` stage + `worker`/`gateway`/`control` stages), dropping each stage's now-redundant in-image `pnpm typecheck` step.

**Architecture:** Per `docs/superpowers/specs/2026-07-09-image-consolidation-design.md`: a `base` stage does the pnpm-workspace install once; three thin stages (`worker`, `gateway`, `control`) each add only their role-specific steps (git for worker's runtime `git` shell-outs, the UI build for control) and `CMD`. `.github/workflows/ci.yaml`'s three affected build steps point at the new file with a `target:`. `images/agent-runner/Dockerfile` is untouched.

**Tech Stack:** Docker BuildKit multi-stage builds (`# syntax=docker/dockerfile:1`), `docker buildx --target`, `docker/build-push-action@v6`.

---

### Task 1: Create the consolidated Dockerfile and remove the old ones

**Files:**
- Create: `images/engine/Dockerfile`
- Delete: `images/worker/Dockerfile`, `images/gateway/Dockerfile`, `images/control/Dockerfile`

- [ ] **Step 1: Create `images/engine/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS base

# Baked-in pnpm, not `corepack enable` alone: corepack lazily downloads
# pnpm into the *current user's* cache on first invocation. Building as
# root then running as `node` means two different cache dirs, so a bare
# `corepack enable` re-fetches pnpm from the npm registry on every
# container start -- which the dev-agents NetworkPolicy (GitHub +
# Anthropic + DNS only, see platform-components design) will block.
RUN npm install --global pnpm@9.15.9

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/activities/package.json ./packages/activities/
COPY packages/backends/package.json  ./packages/backends/
COPY packages/cli/package.json       ./packages/cli/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/control/package.json   ./packages/control/
COPY packages/gateway/package.json   ./packages/gateway/
COPY packages/policies/package.json  ./packages/policies/
COPY packages/ports/package.json     ./packages/ports/
COPY packages/prompts/package.json   ./packages/prompts/
COPY packages/ui/package.json        ./packages/ui/
COPY packages/worker/package.json    ./packages/worker/
COPY packages/workflows/package.json ./packages/workflows/
RUN --mount=type=cache,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --package-import-method copy
COPY . .

FROM base AS worker
# prepareWorkspace and GithubScmPort.push shell out to `git` from inside
# this container (packages/activities/src/workspace, packages/ports/src/github)
# — without it, git clone fails with `spawn git ENOENT` and (pre-fix) retries
# forever. See images/agent-runner/Dockerfile for the same pattern.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN chown -R node:node /app
# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/worker", "run", "start"]

FROM base AS gateway
RUN chown -R node:node /app
USER 1000
CMD ["pnpm", "--filter", "@agentops/gateway", "run", "start"]

FROM base AS control
RUN pnpm --filter @agentops/ui run build
RUN chown -R node:node /app
USER 1000
CMD ["pnpm", "--filter", "@agentops/control", "run", "start"]
```

- [ ] **Step 2: Delete the three old Dockerfiles**

```bash
rm images/worker/Dockerfile images/gateway/Dockerfile images/control/Dockerfile
rmdir images/worker images/gateway images/control
```

- [ ] **Step 3: Build each stage locally and confirm success**

```bash
docker buildx build --load --target worker  -f images/engine/Dockerfile -t engine-worker-test  .
docker buildx build --load --target gateway -f images/engine/Dockerfile -t engine-gateway-test .
docker buildx build --load --target control -f images/engine/Dockerfile -t engine-control-test .
```

Expected: all three builds succeed (each ends with `naming to docker.io/library/engine-<role>-test`). None of the three should have a `pnpm typecheck`/`pnpm --filter ... run typecheck` step in the log — only `worker`'s `apt-get`, `control`'s `pnpm --filter @agentops/ui run build`, and each stage's own `chown`/`CMD` setup.

- [ ] **Step 4: Confirm the pnpm-install layer still caches across an unrelated source change**

```bash
echo "<!-- cache-test-noop -->" >> README.md
docker buildx build --load --target worker -f images/engine/Dockerfile -t engine-worker-test . 2>&1 | grep -A1 "pnpm install --frozen"
git checkout -- README.md
```

Expected: the `pnpm install --frozen-lockfile` step is `CACHED`.

- [ ] **Step 5: Clean up test images**

```bash
docker image rm engine-worker-test engine-gateway-test engine-control-test
```

- [ ] **Step 6: Commit**

```bash
git add images/engine/Dockerfile images/worker images/gateway images/control
git commit -m "ci: consolidate worker/gateway/control into one multi-stage Dockerfile

worker/gateway/control's Dockerfiles were ~80% duplicated (same base,
same manifest COPY block, same pnpm install line) — adding a workspace
package meant editing that block in three places. One base stage now
does the pnpm-workspace install once; worker/gateway/control are thin
derived stages adding only their role-specific steps.

Also drops each stage's own pnpm typecheck: build-images already
needs: build, and the build job's full-repo pnpm typecheck (workspace-
recursive) already covers every package — including @agentops/control
— on the same commit before any image build starts. The in-image
checks were pure redundancy."
```

---

### Task 2: Point CI at the consolidated Dockerfile

**Files:**
- Modify: `.github/workflows/ci.yaml`

- [ ] **Step 1: Update the three affected build steps**

In the `build-images` job, replace the `worker` build step:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/worker/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/worker:${{ github.sha }}
```

with:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/engine/Dockerfile
          target: worker
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/worker:${{ github.sha }}
```

Replace the `gateway` build step:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/gateway/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/gateway:${{ github.sha }}
```

with:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/engine/Dockerfile
          target: gateway
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/gateway:${{ github.sha }}
```

Replace the `control` build step:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/control/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/control:${{ github.sha }}
```

with:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/engine/Dockerfile
          target: control
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/control:${{ github.sha }}
```

The `agent-runner` build step (separate file, separate context) is unchanged. Step order in the job is unchanged.

- [ ] **Step 2: Validate the YAML still parses**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/ci.yaml'); puts 'valid yaml'"`
Expected: `valid yaml`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: build worker/gateway/control from the consolidated engine Dockerfile"
```

---

### Task 3: Fix the stale `images/` line in the architecture doc

**Files:**
- Modify: `docs/ARCHITECTURE.md:246`

- [ ] **Step 1: Update the directory-tree comment**

Current (line 246):

```
images/         # Dockerfiles: worker, gateway, agent-runner (shared across backends, §5.4)
```

Change to:

```
images/         # Dockerfiles: engine (worker/gateway/control, one multi-stage
                # Dockerfile), agent-runner (shared across backends, §5.4)
```

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: fix stale images/ directory listing (missing control, now consolidated)"
```

---

### Task 4: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.** Per project
> memory, Bugbot has been unresponsive on this repo's last several PRs
> despite retriggers — don't block indefinitely on it if it stays silent
> again after one retrigger.

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main --no-edit
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push
gh pr create --base main --title "ci: consolidate engine Dockerfiles, drop redundant typechecks" --body "$(cat <<'EOF'
## Summary
- Replace images/worker/Dockerfile, images/gateway/Dockerfile, images/control/Dockerfile with one multi-stage images/engine/Dockerfile: a shared `base` stage does the pnpm-workspace install once, and worker/gateway/control are thin stages adding only their role-specific steps.
- Drop each stage's own `pnpm typecheck` — build-images already `needs: build`, and the build job's full-repo typecheck (workspace-recursive) already covers every package, including @agentops/control's, on the same commit.
- Fix a stale docs/ARCHITECTURE.md line that predated `control`'s Dockerfile.

See docs/superpowers/specs/2026-07-09-image-consolidation-design.md for the full rationale, including the empirical test showing the duplication wasn't costing real build time (the pnpm-store cache mount already captured most of the savings) — this change is about correctness/DRY, not speed.

## Test plan
- [x] Built all three targets locally (`docker buildx build --target worker|gateway|control -f images/engine/Dockerfile`) — all succeed with no typecheck step in the log.
- [x] Confirmed the pnpm-install layer still shows `CACHED` after an unrelated source change.
- [ ] CI run on this PR is the final check that `build-images` builds all three targets correctly.
EOF
)"
```

(If this PR is created from a branch already tracking `origin`, use `git push` alone as shown; if the branch has no upstream yet, use `git push -u origin HEAD` instead.)

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

Then mark each addressed thread resolved:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments, or stays silent after one retrigger.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
```
Confirm no unresolved review threads remain, then mark this task complete.

---
