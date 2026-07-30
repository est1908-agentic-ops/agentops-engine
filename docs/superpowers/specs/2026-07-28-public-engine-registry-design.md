# Publish engine artifacts to a public registry — design

**Date:** 2026-07-28
**Status:** design in review
**Repo:** `agentops-engine`
**Baseline:** `origin/main` @ `4311285`

This is **S1** in the flair.hr instance decomposition
(`agentops-platform/docs/superpowers/specs/2026-07-28-agentops-flairhr-instance-design.md`).
It is a prerequisite for that instance deploying, and it completes half of template pivot
step 3.

## 1. Why

Today every engine artifact — four images **and both Helm charts** — lives in
`gitactions.est1908.top/agentic-ops`, a private Forgejo registry on the author's home lab.

The charts being there is the sharp end. `clusters/ops/engine/application.yaml` sources its
chart from `oci://gitactions.est1908.top/agentic-ops/engine`, and the `project-workers`
ApplicationSet sources `oci://gitactions.est1908.top/agentic-ops/project-worker`. An
ArgoCD instance without credentials to that registry cannot **render** those Applications at
all — this is not a pull-secret detail that surfaces as `ImagePullBackOff`, it is a manifest
generation failure.

Two consequences:

- **The flair.hr instance cannot deploy.** A company platform cannot depend on a personal
  home-lab registry for its control plane; that is a handover blocker, not just an
  availability one.
- **No template adopter can deploy either.** The template pivot's premise is "fork this and
  run it". Every adopter hits the same wall.

`@agentic-ops/engine-sdk` is already published publicly to npm (0.1.3), so public
distribution of engine artifacts is established practice in this repo, not a new posture.

## 2. Scope

**In scope:** publishing the four images and two charts to a public registry from CI;
updating the chart defaults that point at the private registry; resolving the
`bump-platform` job that the registry change breaks; and verifying ArgoCD and ArgoCD Image
Updater can consume the public artifacts anonymously.

**Out of scope:** migrating the homelab cluster's pins (that repo's own change — the
artifacts it needs already exist in both registries); decommissioning the Forgejo registry
itself, which still hosts `artem-private-agents`' project-built worker image; the rest of
template pivot step 3 (`__TOKEN__` placeholders, `.template` sentinel,
`check-customized.sh`, flipping repos public); any change to what the images contain.

## 3. What gets published

| Artifact | Kind | Today | After |
|---|---|---|---|
| `worker` | image | `gitactions.est1908.top/agentic-ops/worker:<sha>` | `ghcr.io/est1908-agentic-ops/worker:<sha>` |
| `gateway` | image | `…/agentic-ops/gateway:<sha>` | `ghcr.io/est1908-agentic-ops/gateway:<sha>` |
| `control` | image | `…/agentic-ops/control:<sha>` | `ghcr.io/est1908-agentic-ops/control:<sha>` |
| `agent-runner` | image | `…/agentic-ops/agent-runner:<sha>` + `:latest` | `ghcr.io/est1908-agentic-ops/agent-runner:<sha>` + `:latest` |
| `engine` | Helm chart (OCI) | `oci://…/agentic-ops/engine`, version `0.0.0-<sha>` | `oci://ghcr.io/est1908-agentic-ops/engine`, same version scheme |
| `project-worker` | Helm chart (OCI) | `oci://…/agentic-ops/project-worker`, version `0.0.0-<sha>` | `oci://ghcr.io/est1908-agentic-ops/project-worker`, same version scheme |

The `0.0.0-<sha>` chart version scheme is unchanged. Two version axes stay distinct, as the
project-worker onboarding design set out: the **chart version** is engine-owned and bumped
per merge, the **image tag** is what a consumer pins.

Both charts must ship. The flair instance's first workload is a Tier-2 project worker, so
`project-worker` is load-bearing there, not optional.

## 4. Registry choice: GHCR

`ghcr.io/est1908-agentic-ops`, matching the repo's owning org so CI can push with the
built-in `GITHUB_TOKEN`.

Why:

- **No long-lived credential.** `permissions: packages: write` plus `${{ secrets.GITHUB_TOKEN }}`
  replaces the `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` pair. One fewer secret to rotate,
  and pushes are scoped to the workflow run.
- **Public packages from a private repo are supported.** `agentops-engine` stays private;
  the artifacts become public. This is the same split `publish-sdk.yaml` already relies on.
- **Anonymous pulls, no rate-limit cliff.** Docker Hub's anonymous pull limits make it
  unsuitable for a cluster that pulls on every rollout.
- **OCI Helm charts are first-class.** `helm push … oci://ghcr.io/<org>` lands the chart at
  `ghcr.io/<org>/<chart-name>`, which is the full-path form ArgoCD requires (it resolves the
  chart tag against `repoURL` directly and does **not** append the `chart` field — a bare
  namespace 404s).

Rejected: **keeping Forgejo and making it public** — the availability and handover problem
is the point, not the auth; **Docker Hub** — anonymous pull limits; **a flair-owned
registry** — would make a personal repo push into a company namespace, and would not help
any other adopter.

### 4.1 Clean cut (revised 2026-07-30)

**Superseded decision.** This section originally specified dual-push for a transition
period, and that is how the work shipped on 2026-07-28 (build `ea577b08` pushed all six
artifacts to both registries). At the operator's direction the Forgejo push has now been
removed: CI publishes to GHCR only.

What made the clean cut acceptable in the end:

- **Removing a push does not delete existing artifacts.** Every tag Forgejo already holds —
  including the `0.0.0-fd738fdd…` engine chart the homelab is currently pinned to — stays
  there. The live cluster keeps resolving its current pin with no change at all.
- **The homelab migration is still an independent change** in its own repo, because the
  artifacts it needs already exist in both places.

What it costs, and this is real: **new engine builds land only in GHCR.** While the GHCR
packages are private, a merged engine PR produces artifacts the cluster cannot read. That is
not an outage — Image Updater simply finds nothing new and the cluster stays on its current
version — but engine updates are silently paused until the packages are public. The window
closes the moment visibility is flipped (§7).

The original argument for dual-push was rollback safety, and it still applies in one
direction: reverting a consumer to `gitactions.est1908.top` works for any sha built before
2026-07-30, and stops working for anything built after.

**Not in scope of this removal:** `artem-private-agents`' Tier-2 worker image, which is
project-built into `gitactions.est1908.top` by a different repo's CI. It is not an engine
artifact, it keeps living there, and the homelab's `registry-credentials` Secret must
therefore keep existing.

## 5. CI changes

All in `.github/workflows/ci.yaml`. The `build` job (lint, typecheck, test, helm lint, chart
tests) is unchanged.

**`build-engine-images`:**

- Add `permissions: packages: write` alongside `contents: read`.
- Replace the Forgejo `docker/login-action` step with one for `ghcr.io` using
  `${{ github.actor }}` and `${{ secrets.GITHUB_TOKEN }}`. The
  `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` repo secrets become unused and can be deleted.
- Point each `docker/bake-action` `set:` entry at the GHCR ref:
  `worker.tags=ghcr.io/est1908-agentic-ops/worker:<sha>`, and likewise for `gateway` and
  `control`. One tag per target after the clean cut (§4.1).

  Recorded because it cost a red build during the dual-push phase, and applies to anyone
  adding a second registry later — the three plausible multi-tag forms do **not** behave
  alike. Verified with `docker buildx bake --print` (buildx v0.35.0):

  | Form | Result |
  |---|---|
  | `tags=a` then `tags+=b` | `["a","b"]` — appends |
  | `tags=a` then `tags=b` | `["a","b"]` — also appends, despite reading like an override |
  | `tags=a,b` | **fails** — one tag string, `invalid tag "a,b": invalid reference format` |

  If a second registry is ever reintroduced, use `+=` and never comma-join.
- In the chart step, add `helm registry login ghcr.io` and a second `helm push` per chart to
  `oci://ghcr.io/est1908-agentic-ops`. Package once, push twice; the `.tgz` is identical.

**`build-agent-runner-image`:** same treatment — `packages: write`, a GHCR login, and both
`<sha>` and `:latest` tags for each registry.

**Runner:** the jobs stay on `self-hosted`. GHCR login and push work there, and the local
BuildKit layer cache is why image builds are on those runners. This deliberately differs
from the template's `manifests` lint job, which moved to `ubuntu-latest` because adopters
have no self-hosted runner — that reasoning applies to jobs adopters must run, not to this
repo's own publishing.

## 6. Chart defaults

`charts/engine/values.yaml` defaults `image.repository: gitactions.est1908.top/agentic-ops`.
A publicly published chart whose default image repository is a private registry is a trap:
an adopter who does not override it gets an unpullable image and no hint why. Change the
default to `ghcr.io/est1908-agentic-ops`.

`charts/project-worker/values.yaml` defaults `imagePullSecretName: registry-credentials`.
A project worker pulling a public image needs no pull secret, so the chart must render
correctly when this is empty — verify the template guards it rather than emitting an
`imagePullSecrets` entry naming a Secret that does not exist. Leave the default alone if
the guard exists; the flair instance sets it explicitly either way.

Both charts' golden-render tests (`charts/*/tests/render.golden.yaml`) contain the registry
string and must be regenerated. `charts/project-worker/tests/run.sh` also references it.

## 7. Package visibility — the step that silently breaks everything

**A package pushed by Actions inherits the repository's visibility.** `agentops-engine` is
private, so all six packages are created **private**, and an unauthenticated ArgoCD gets
`403` — which surfaces as a chart-resolution failure, exactly the symptom this whole spec
exists to remove.

Flipping visibility is a **one-time manual step per package**, in each package's settings
(or via the packages API), and there are six: `worker`, `gateway`, `control`,
`agent-runner`, `engine`, `project-worker`. It cannot be done before the first push, since
the package does not exist yet.

So the ordering is: merge the CI change → let one `main` build publish all six → flip all
six to public → verify anonymous pull (§10). Treating this as an afterthought is the most
likely way for this work to look done and not be.

## 8. The `bump-platform` job

The registry change **breaks CI** unless this job is handled in the same change.

`scripts/bump-platform-engine-tags.sh` regex-matches
`repoURL: oci://gitactions\.est1908\.top/agentic-ops/engine` and raises
`SystemExit("expected exactly one engine chart targetRevision to update")` when it does not
match exactly once. Nothing about that is tolerant of a registry rename.

There is a second, larger problem. The job checks out `est1908-agentic-ops/agentops-platform`
and commits image bumps to its `main` on every engine merge — visible in that repo's log as
`chore(engine): bump worker images to 4311285`, `… d179d56`. But that repo is **the
template**; the live cluster moved to `agentops-platform-homelab`. So the job currently
writes deploy pins for a cluster that does not exist, into a repo about to be published as a
"fork me" template, where hardcoded shas are noise at best. Meanwhile ArgoCD Image Updater
is the intended mechanism for the live cluster and is already deployed.

**Recommendation: delete the `bump-platform` job and the script.** Image Updater covers the
image tags; the chart `targetRevision` was never covered by either mechanism and remains a
manual bump on chart-template changes (§9). Deleting removes a cross-repo PAT
(`PLATFORM_PAT`), a broken regex, and a stream of misleading commits into the template.

Two weaker alternatives, recorded because deletion is a one-way door:

- **Retarget it at `agentops-platform-homelab`** — restores a working fallback for the live
  cluster, at the cost of keeping the PAT and a cross-repo coupling that does not scale as
  instances multiply (flair is the second; every new instance would need its own job).
- **Update only the regex** — smallest diff, keeps CI green, and leaves the misdirected
  commits flowing into the template. Not recommended.

## 9. What this does not fix

**Image Updater never bumps the chart `targetRevision`.** It updates image tags only. Any
change touching `charts/engine/**` or `charts/project-worker/**` still requires a manual
`targetRevision` bump in each consuming repo to the merge sha, or that cluster runs new
image code against an old chart. That is precisely the failure that crash-looped the homelab
worker with `ENOENT /etc/managed-projects` when the ConfigMap-reading image landed on a
chart with no volume mount and no `secrets:get` RBAC. Publishing charts publicly changes
where they are pulled from, not this hazard.

A code-only change needs no bump. The rule belongs in each consumer's `CLAUDE.md`, and this
spec does not remove the need for it.

## 10. Verification

Ordered, because several steps can only be checked after the one before.

1. **CI green on the branch.** PR builds do not push (`if: github.ref == 'refs/heads/main'`),
   so a PR proves only that the workflow parses and the build still works. Regenerated chart
   golden tests pass.
2. **One `main` build publishes all six artifacts** to GHCR. Done on 2026-07-28 by build
   `ea577b08`, which also confirmed the charts' digests are identical to the Forgejo copies
   (`sha256:3f8d00fb…` engine, `sha256:ded2061e…` project-worker) — evidence that "package
   once, push twice" produced byte-identical artifacts, so a consumer can move registries
   without a chart version change.
3. **All six packages flipped to public** (§7).
4. **Anonymous pull works, from a machine with no credentials:**
   `docker logout ghcr.io && docker pull ghcr.io/est1908-agentic-ops/worker:<sha>` and
   `helm pull oci://ghcr.io/est1908-agentic-ops/engine --version 0.0.0-<sha>`. This is the
   check that actually proves the premise; steps 1–3 can all pass while this fails.
5. **ArgoCD renders a chart from GHCR without a repository credential** — the failure mode
   §1 is about. Verify against a scratch Application, not by merging into a live cluster.
6. **ArgoCD Image Updater resolves `newest-build` against GHCR.** Its registry config needs
   `prefix: ghcr.io` and `api_url: https://ghcr.io`. Whether it can read tag metadata
   **anonymously** for public packages, or still needs a credential, is open — GHCR issues
   anonymous Bearer tokens for public reads, but Image Updater's registry client must
   negotiate that challenge. If a credential is required, a read-only PAT in a pull secret
   is the fallback, and `registry-rbac.yaml` in each consumer stays alive. **Resolving this
   here closes the open item the flair spec carries as an S3 unknown** — it belongs to
   whoever owns the registry.
7. **No secrets in the published images.** They become world-pullable, so this is the last
   moment it is cheap to check: inspect the layers of each of the four images for `.env`
   files, baked tokens, or `.npmrc` credentials before step 3 flips visibility. The
   Dockerfiles copy build output rather than secrets, so this is expected to pass — but
   "expected to pass" and "checked once while it was still private" are different states.

## 11. Consequences to accept

- **The engine's compiled code becomes publicly readable.** Anyone can pull and inspect the
  four images and both charts. That follows from the template going public and is consistent
  with `@agentic-ops/engine-sdk` already being on npm, but it is a real change in posture and
  is worth stating rather than assuming.
- **GHCR is now the only source of new engine artifacts** (§4.1). While the packages are
  private, a merged engine PR produces artifacts no cluster can read: Image Updater finds
  nothing new and consumers silently stay on their current version. Not an outage, but
  engine updates are paused until visibility is flipped.
- **Reverting a consumer to Forgejo only works for pre-2026-07-30 shas.** Everything built
  before the clean cut exists in both registries; nothing after exists in Forgejo.
- **Ordering discipline.** Steps 3 and 7 of §10 are manual and easy to skip, and skipping
  either produces a system that looks published and is not (403s), or one that is published
  with more than intended.

## 12. References

- `agentops-platform/docs/superpowers/specs/2026-07-28-agentops-flairhr-instance-design.md`
  — S2, the consumer that motivates this work; its §2.1 lists this as a blocker.
- `docs/superpowers/specs/2026-07-12-project-worker-onboarding-design.md` — the
  `project-worker` chart, its OCI publishing, and the two-version-axes distinction.
- `.github/workflows/publish-sdk.yaml` — the existing public-publishing precedent, including
  why npm provenance is omitted for a private source repo.
- `.github/workflows/ci.yaml` — the pipeline §5 modifies.
- `scripts/bump-platform-engine-tags.sh` — the script §8 recommends deleting.
- `agentops-platform/docs/superpowers/specs/2026-07-15-agentops-platform-template-design.md`
  — the template pivot whose step 3 this half-completes.
