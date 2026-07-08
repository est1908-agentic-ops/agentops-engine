# CI Image Build Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `build-images` CI runs reuse Docker layer cache and pnpm package cache across runs on the persistent self-hosted VPS, instead of rebuilding everything from scratch every time.

**Architecture:** Two independent changes, per `docs/superpowers/specs/2026-07-09-ci-image-build-caching-design.md`: (1) switch the GitHub Actions buildx setup to the host's built-in `docker` driver so the persistent daemon's layer cache survives across jobs, and (2) reorder `images/worker/Dockerfile`, `images/control/Dockerfile`, `images/gateway/Dockerfile` to copy only workspace manifests before `pnpm install`, with a BuildKit cache mount for the pnpm store. `images/agent-runner/Dockerfile` needs no changes (no pnpm install step) — it benefits from change 1 alone.

**Tech Stack:** Docker BuildKit (`# syntax=docker/dockerfile:1`), `docker buildx`, GitHub Actions (`docker/setup-buildx-action@v3`), pnpm 9 workspaces.

---

### Task 0: Confirm local verification environment

**Files:** none (environment check only)

- [ ] **Step 1: Confirm Docker is reachable and note the active builder's driver**

Run: `docker buildx ls`
Expected: one active builder (marked `*`) whose `DRIVER/ENDPOINT` column says `docker` (not `docker-container`). This matches the driver the CI change will use, so local verification builds below are representative of the real change.

If the active builder's driver is `docker-container` instead, the cache-hit checks in Tasks 2-4 won't demonstrate the fix (a fresh `docker-container` builder has no cache from a prior run). In that case, switch first: `docker buildx use default` (or whichever context-based builder shows driver `docker` in the `ls` output), then re-run `docker buildx ls` to confirm.

---

### Task 1: Switch buildx to the built-in `docker` driver in CI

**Files:**
- Modify: `.github/workflows/ci.yaml:49`

- [ ] **Step 1: Edit the buildx setup step**

Current (`build-images` job, line 49):

```yaml
      - uses: docker/setup-buildx-action@v3
```

Change to:

```yaml
      - uses: docker/setup-buildx-action@v3
        with:
          driver: docker
```

- [ ] **Step 2: Validate the YAML still parses**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/ci.yaml'); puts 'valid yaml'"`
Expected: `valid yaml`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: use the host's built-in docker buildx driver

The self-hosted runner pool is 4 instances on one persistent VPS
sharing one Docker daemon. The default docker-container driver spins
up a fresh, uniquely-named builder (and cache) per run, throwing away
the daemon's persistent layer cache even though the host itself never
changes. driver: docker uses the daemon's own BuildKit worker instead,
so layer cache survives across runs with no extra cache-from/cache-to
config."
```

---

### Task 2: Reorder `images/worker/Dockerfile` for dependency-layer caching

**Files:**
- Modify: `images/worker/Dockerfile`

- [ ] **Step 1: Replace the install block**

Current file (in full):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# prepareWorkspace and GithubScmPort.push shell out to `git` from inside
# this container (packages/activities/src/workspace, packages/ports/src/github)
# — without it, git clone fails with `spawn git ENOENT` and (pre-fix) retries
# forever. See images/agent-runner/Dockerfile for the same pattern.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Baked-in pnpm, not `corepack enable` alone: corepack lazily downloads
# pnpm into the *current user's* cache on first invocation. Building as
# root then running as `node` means two different cache dirs, so a bare
# `corepack enable` re-fetches pnpm from the npm registry on every
# container start -- which the dev-agents NetworkPolicy (GitHub +
# Anthropic + DNS only, see platform-components design) will block.
RUN npm install --global pnpm@9.15.9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck
RUN chown -R node:node /app

# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/worker", "run", "start"]
```

Replace the `WORKDIR /app` through `RUN pnpm typecheck` block with:

```dockerfile
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
    pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY . .
RUN pnpm typecheck
RUN chown -R node:node /app
```

(The `apt-get`/`npm install --global pnpm@9.15.9` lines above `WORKDIR /app`, and the `USER 1000`/`CMD` lines below, are unchanged.)

- [ ] **Step 2: Build the image cold and confirm it still succeeds**

Run: `docker buildx build --load -f images/worker/Dockerfile -t agentops-worker-cache-test .`
Expected: build succeeds (ends with `naming to docker.io/library/agentops-worker-cache-test`), same as before this change.

- [ ] **Step 3: Prove an unrelated source change no longer busts the install layer**

```bash
echo "<!-- cache-test-noop -->" >> README.md
docker buildx build --load -f images/worker/Dockerfile -t agentops-worker-cache-test . 2>&1 | grep -i "pnpm install"
```

Expected: the line for the `pnpm install --frozen-lockfile` step is prefixed `CACHED` (e.g. `CACHED [7/16] RUN --mount=type=cache,target=/pnpm-store,sharing=locked pnpm install --frozen-lockfile --store-dir /pnpm-store`) — proving the install layer was reused even though `README.md` (copied by the later `COPY . .`) changed.

- [ ] **Step 4: Clean up the test artifacts**

```bash
git checkout -- README.md
docker image rm agentops-worker-cache-test
```

- [ ] **Step 5: Commit**

```bash
git add images/worker/Dockerfile
git commit -m "ci(worker): cache pnpm install layer separately from source copy

COPY . . ran before pnpm install, so any change anywhere in the repo
invalidated the install layer even when dependencies didn't change.
Copy only the workspace manifests first, install with a BuildKit cache
mount for the pnpm store, then copy the rest of the source."
```

---

### Task 3: Reorder `images/gateway/Dockerfile` for dependency-layer caching

**Files:**
- Modify: `images/gateway/Dockerfile`

- [ ] **Step 1: Replace the install block**

Current file (in full):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# Same rationale as images/worker/Dockerfile: baked-in pnpm, not `corepack
# enable` alone, to avoid a runtime fetch the dev-agents NetworkPolicy
# (GitHub + Anthropic + DNS only) would block.
RUN npm install --global pnpm@9.15.9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck
RUN chown -R node:node /app

# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/gateway", "run", "start"]
```

Replace the `WORKDIR /app` through `RUN pnpm typecheck` block with:

```dockerfile
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
    pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY . .
RUN pnpm typecheck
RUN chown -R node:node /app
```

(The `npm install --global pnpm@9.15.9` line above `WORKDIR /app`, and the `USER 1000`/`CMD` lines below, are unchanged.)

- [ ] **Step 2: Build the image cold and confirm it still succeeds**

Run: `docker buildx build --load -f images/gateway/Dockerfile -t agentops-gateway-cache-test .`
Expected: build succeeds.

- [ ] **Step 3: Prove an unrelated source change no longer busts the install layer**

```bash
echo "<!-- cache-test-noop -->" >> README.md
docker buildx build --load -f images/gateway/Dockerfile -t agentops-gateway-cache-test . 2>&1 | grep -i "pnpm install"
```

Expected: the `pnpm install --frozen-lockfile` step line is prefixed `CACHED`.

- [ ] **Step 4: Clean up the test artifacts**

```bash
git checkout -- README.md
docker image rm agentops-gateway-cache-test
```

- [ ] **Step 5: Commit**

```bash
git add images/gateway/Dockerfile
git commit -m "ci(gateway): cache pnpm install layer separately from source copy

Same fix as the worker image: copy workspace manifests, install with a
BuildKit cache mount for the pnpm store, then copy the rest of the
source, so unrelated source changes don't force a reinstall."
```

---

### Task 4: Reorder `images/control/Dockerfile` for dependency-layer caching

**Files:**
- Modify: `images/control/Dockerfile`

- [ ] **Step 1: Replace the install block**

Current file (in full):

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

Replace the `WORKDIR /app` through `RUN pnpm --filter @agentops/control run typecheck` block with:

```dockerfile
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
    pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY . .
RUN pnpm --filter @agentops/ui run build
RUN pnpm --filter @agentops/control run typecheck
```

(The `npm install --global pnpm@9.15.9` line above `WORKDIR /app`, and the `chown`/`USER 1000`/`CMD` lines below, are unchanged.)

- [ ] **Step 2: Build the image cold and confirm it still succeeds**

Run: `docker buildx build --load -f images/control/Dockerfile -t agentops-control-cache-test .`
Expected: build succeeds.

- [ ] **Step 3: Prove an unrelated source change no longer busts the install layer**

```bash
echo "<!-- cache-test-noop -->" >> README.md
docker buildx build --load -f images/control/Dockerfile -t agentops-control-cache-test . 2>&1 | grep -i "pnpm install"
```

Expected: the `pnpm install --frozen-lockfile` step line is prefixed `CACHED`.

- [ ] **Step 4: Clean up the test artifacts**

```bash
git checkout -- README.md
docker image rm agentops-control-cache-test
```

- [ ] **Step 5: Commit**

```bash
git add images/control/Dockerfile
git commit -m "ci(control): cache pnpm install layer separately from source copy

Same fix as the worker/gateway images: copy workspace manifests,
install with a BuildKit cache mount for the pnpm store, then copy the
rest of the source, so unrelated source changes don't force a
reinstall."
```

---

### Task 5: Ship the change

**Files:** none (process task)

- [ ] **Step 1: Sync with `main`**

```bash
git fetch origin
git rebase origin/main
```

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "ci: cache image builds on the self-hosted runner" --body "$(cat <<'EOF'
## Summary
- Switch buildx to the built-in `docker` driver (`docker/setup-buildx-action@v3`) so the persistent self-hosted VPS's layer cache survives across CI runs instead of being thrown away with a fresh builder every time.
- Reorder `images/worker/Dockerfile`, `images/gateway/Dockerfile`, `images/control/Dockerfile` to copy workspace manifests and run `pnpm install --frozen-lockfile` before copying the rest of the source, with a BuildKit cache mount for the pnpm store — so unrelated source changes no longer force a full reinstall, and even lockfile changes reuse already-downloaded packages.
- `images/agent-runner/Dockerfile` needs no changes; it benefits from the driver switch alone.

See `docs/superpowers/specs/2026-07-09-ci-image-build-caching-design.md` for the full design and rationale.

## Test plan
- [x] Verified locally with `docker buildx build` (driver `docker`) that each modified Dockerfile still builds successfully.
- [x] Verified an unrelated source change (`README.md`) no longer busts the `pnpm install` layer — confirmed `CACHED` in the build log for all three images.
- [ ] First real CI run on the self-hosted runner is the final verification that the daemon-level cache persists across jobs as expected.
EOF
)"
```

- [ ] **Step 3: Get CI green**

Run: `gh pr checks --watch`

If a check fails, read the failing job's logs (`gh run view --log-failed`), fix the root cause, commit, and re-push. Repeat until all checks pass. Do not skip failing checks or merge with red CI.

- [ ] **Step 4: Wait for and resolve the Bugbot review**

Note: per project memory, Bugbot has been inactive on this repo's last 2 PRs despite retriggers — don't block shipping on it if it never responds within a reasonable wait. If it does respond, address each comment: fix genuine issues with a new commit, or reply explaining why not for anything you disagree with. Don't dismiss without a reason.

- [ ] **Step 5: Report the PR URL back to the user**

---
