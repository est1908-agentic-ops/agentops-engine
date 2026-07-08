# CI: Switch to Self-Hosted Runners — Design

Status: draft · 2026-07-08 · Owner: Artem

## Context

`.github/workflows/ci.yaml` runs all three jobs (`build`, `build-images`, `bump-platform`) on GitHub-hosted `ubuntu-latest` runners today. Artem has a self-hosted runner pool registered at the `est1908-agentic-ops` org level with the generic `self-hosted` label (repo-level API shows 0 runners, and org-level runner listing needs `admin:org` scope this session doesn't have — confirmed verbally rather than via API).

## Goal

Point all CI jobs at the self-hosted pool instead of GitHub-hosted runners.

## Non-goals

- Provisioning or registering the runner itself — assumed already done.
- Concurrency controls (`concurrency:` group / cancel-in-progress) — declined; the persistent-runner queuing characteristic predates this change and isn't being addressed here.
- OS/arch-specific labels or a dedicated runner group — one generic pool, one generic label.
- Any hardening for untrusted-fork PRs — the repo is private, so `pull_request` runs already only come from trusted collaborators.

## Design

In `.github/workflows/ci.yaml`, change `runs-on: ubuntu-latest` to `runs-on: self-hosted` on all three jobs (`build` line 10, `build-images` line 42, `bump-platform` line 105). No other lines change — same steps, same actions, same secrets.

## Risk

If the org-level runner isn't actually reachable (unverified this session), the next push/PR will show jobs stuck in "Waiting for a runner" instead of failing fast. First real CI run after merge is the verification step.

**Runner persistence, independent of the fork-PR non-goal above.** GitHub-hosted `ubuntu-latest` gives every job a fresh, single-use VM. A self-hosted pool is shared and (unless configured otherwise) reused across jobs: `build` runs on every `pull_request` from any collaborator and executes `pnpm install` plus arbitrary transitively-pulled npm code; `build-images`/`bump-platform` run only on `main` pushes but handle `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` and `PLATFORM_PAT` (a cross-repo GitOps write credential). If the runner doesn't wipe its workspace/environment cleanly between jobs, a `build` run could leave something behind that a later `main`-branch job's secrets then touch. This is a materially larger blast radius than on ephemeral GitHub-hosted runners even though the repo is private — "trusted collaborator" isn't the same guarantee as "trusted with prod registry/GitOps credentials." Accepted as a known trade-off for this change; verifying the runner's per-job isolation policy (and scoping down `GITHUB_TOKEN` permissions on `build`/`bump-platform`, which today only `build-images` does) is a recommended fast-follow, not blocking this PR.
