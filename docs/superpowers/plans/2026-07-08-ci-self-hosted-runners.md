# CI: Switch to Self-Hosted Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point all three CI jobs in `.github/workflows/ci.yaml` at the self-hosted runner pool instead of GitHub-hosted `ubuntu-latest`.

**Architecture:** Single-file config change — no code, no new infra. `runs-on: ubuntu-latest` becomes `runs-on: self-hosted` on each of the three jobs (`build`, `build-images`, `bump-platform`). Everything else in the workflow (steps, actions, secrets, triggers) is untouched.

**Tech Stack:** GitHub Actions workflow YAML.

Design doc: [docs/superpowers/specs/2026-07-08-ci-self-hosted-runners-design.md](../specs/2026-07-08-ci-self-hosted-runners-design.md)

---

### Task 1: Switch all three jobs to `self-hosted`

**Files:**
- Modify: `.github/workflows/ci.yaml:10,42,105`

- [ ] **Step 1: Change the `build` job's runner**

In `.github/workflows/ci.yaml`, line 10:

```yaml
# before
  build:
    runs-on: ubuntu-latest
```

```yaml
# after
  build:
    runs-on: self-hosted
```

- [ ] **Step 2: Change the `build-images` job's runner**

In `.github/workflows/ci.yaml`, line 42:

```yaml
# before
  build-images:
    runs-on: ubuntu-latest
```

```yaml
# after
  build-images:
    runs-on: self-hosted
```

- [ ] **Step 3: Change the `bump-platform` job's runner**

In `.github/workflows/ci.yaml`, line 105:

```yaml
# before
  bump-platform:
    runs-on: ubuntu-latest
```

```yaml
# after
  bump-platform:
    runs-on: self-hosted
```

- [ ] **Step 4: Diff review — confirm this is the only change**

```bash
git diff .github/workflows/ci.yaml
```

Expected: exactly three changed lines, each `-    runs-on: ubuntu-latest` / `+    runs-on: self-hosted`. No other lines touched (jobs, steps, secrets, triggers all identical to before).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: switch jobs to self-hosted runners"
```

---

### Task 2: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until CI is green AND Bugbot
> has either resolved-clean comments or is confirmed non-responsive per the
> known-inactive note below. Check with `gh pr view --json reviews,comments`
> before claiming done.**
>
> **Known repo behavior:** Bugbot has not responded on the last 2 PRs in
> `agentops-engine` despite retriggers (`bugbot run`). Attempt Step 5 once,
> retrigger once if nothing posts within ~10 minutes, then proceed without
> blocking on it — do not loop indefinitely waiting for a review that has a
> track record of never arriving on this repo.
>
> **This specific change's real verification is Step 4:** since the whole
> point is routing jobs to a self-hosted runner, a green `gh pr checks --watch`
> here is the only concrete proof the runner is actually reachable and
> correctly labeled — treat a stuck/queued check (not a fast failure) as
> confirmation the runner setup itself needs attention before this can merge.

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "ci: switch to self-hosted runners"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red. If a check sits queued/"waiting for a runner" rather than failing outright, that means the self-hosted runner isn't actually reachable — stop and flag this to Artem rather than waiting indefinitely.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```

Per the known-inactive note above: wait ~10 minutes, retrigger once if silent, then proceed to Step 7 if still nothing rather than blocking further.

- [ ] **Step 6: Address each Bugbot comment (if any posted)**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
# List unresolved threads, then resolve each addressed one by id:
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments, or until the known-inactive escape hatch applies.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed (or confirmed non-responsive)
pnpm lint && pnpm typecheck && pnpm test   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
