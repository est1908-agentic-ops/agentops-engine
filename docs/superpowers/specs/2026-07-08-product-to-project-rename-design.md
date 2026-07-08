# `product` → `project` rename — design

Status: draft v1 · 2026-07-08 · Owner: Artem

## 1. Why

The codebase currently has two words for what is the same thing: a **project registry entry** already bundles `{ product, repo, trackerType, tokenEnvVar }` — i.e. "project" is already the container name, and "product" is just a field inside it (a short, unique slug distinct from the full `owner/repo` path, used for env var names like `GITHUB_TOKEN__<PRODUCT>`, task IDs like `issue-<product>-<issueNumber>`, and Helm values keys). Keeping both words is confusing, and becomes actively conflicting once the DB-backed `ManagedProject` entity (see the companion design, [2026-07-08-managed-project-registry-design.md](2026-07-08-managed-project-registry-design.md)) lands — we'd otherwise have "a Project has a product field."

This is a pure rename: swap the word `product` → `project` everywhere it names this concept. No structural change — the short-slug-plus-repo shape stays exactly as it is today. It's a prerequisite for the managed-project-registry work so that work launches on the final vocabulary instead of needing a second rename immediately after.

## 2. Scope

**In scope** — rename the identifier in each of these, keeping behavior identical (verified by the existing test suite passing unchanged aside from renamed test descriptions/fixtures):

| Package | Renames |
|---|---|
| `packages/contracts` | `product-config.ts` → `project-config.ts`; `ProductConfigSchema` → `ProjectConfigSchema`; `ProductConfig` → `ProjectConfig`; `DEFAULT_PRODUCT_CONFIG` → `DEFAULT_PROJECT_CONFIG`; `InvalidProductConfigError` → `InvalidProjectConfigError`; `parseProductConfig` → `parseProjectConfig`; `ProjectRegistryEntrySchema.product` field → `.project`; `TaskInput.product` field → `.project`; error strings ("duplicate product ...") → "duplicate project ..." |
| `packages/gateway` | `product` params/vars in `create-gateway-server.ts`, `start-dev-cycle.ts`, `main.ts` → `project`; comments |
| `packages/cli` | `main.ts`: `resolveProjectEntry(registry, product, repo)` → `(registry, project, repo)`; `cmdStart(taskId, goal, product, repo, ...)` → `project`; CLI flag `--product` → `--project` (keep no deprecated alias — this is pre-webhook, operator-only tooling, not a public API) |
| `packages/worker` | log line `entry.product` → `entry.project` |
| `packages/policies` | `ProductConfig` type references → `ProjectConfig` |
| `packages/activities` | `load-project-registry.ts`: `entry.product` → `entry.project`, error strings; `load-product-config.ts` → `load-project-config.ts` (+ `loadProductConfig` → `loadProjectConfig`); `create-activities.ts`: `ProductConfig`/`parseProductConfig`/`loadProductConfig` imports, `resolveRepoConfig`'s `{ product }` return field → `{ project }` |
| `packages/workflows` | `platform-activities-api.ts`: `PlatformActivities.resolveRepoConfig` return type's `product` field → `project`, `ProductConfig` → `ProjectConfig`; `platform.ts`: comment + `product: resolved.product` → `project: resolved.project` |
| `packages/backends` | `k8s-job-runner.ts` + its test: comments/test descriptions about "a product's own agentops.json" → "a project's own agentops.json" (its example placeholder image string too, for consistency). **Excluded:** `claude-backend.ts`'s "that's a product decision (what budget?)" — generic English usage (a product-management decision), not this concept — leave untouched. |
| `packages/control` | `read-registry-repos.test.ts` fixture data (`product:` field, `PRODUCT_A` env var name) — the non-test `read-registry-repos.ts` itself has no `product` reference. |
| `charts/engine` | `_helpers.tpl`, `deployment.yaml`, `gateway-deployment.yaml`: Helm loop var `$product` → `$project`; `values.yaml` comments |
| `docs/ARCHITECTURE.md`, `docs/MILESTONES.md`, `docs/M0-SPEC.md` | terminology pass: "product" → "project" wherever it means this concept (e.g. "Multi-product topology" → "Multi-project topology", "N product repos" → "N project repos", `agentops.json` description, per-product namespaces/quotas language). **Excluded:** generic English uses of "product" meaning "the software being built" (e.g. ARCHITECTURE.md line 5's "improve a product with minimal human involvement") — judgment call per occurrence, not a blind pass. `AGENTS.md` has zero occurrences — nothing to change there. |

**Out of scope:**
- Dated historical specs under `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` — those are point-in-time records (the org-migration memory already established this repo treats stale references in dated docs as acceptable history, not something retroactively fixed).
- `agentops-platform` — only its `values.yaml` comments reference "product" in prose; no structural key is named `product` there (the map is already `projects:`). A one-line comment fix there is optional, not blocking.
- Any change to what a project's short-slug *is* (still a required, registry-unique string distinct from `repo`) — this doc renames the word, not the shape.
- No live Temporal search attribute is affected — confirmed none is currently registered under "product" (checked `clusters/ops/platform/temporal/` and all `SearchAttribute` call sites — none reference it; ARCHITECTURE.md §5.7's "Temporal search attributes (product)" is aspirational future work, not implemented).

## 3. Sequencing

Contracts first (AGENTS.md rule 3), then consumers, matching the import graph so nothing is left pointing at a renamed-but-not-yet-updated symbol mid-change:

1. `packages/contracts` (schemas, types, error class, field names)
2. `packages/policies`, `packages/activities` (consumers of the contracts types)
3. `packages/workflows`, `packages/backends`, `packages/control` (further consumers of `ProductConfig`/registry entries pulled in by the merge from `main` after this doc's first draft)
4. `packages/cli`, `packages/gateway`, `packages/worker` (consumers + their own local `product` vars)
5. `charts/engine` (Helm templates + values comments)
6. `docs/ARCHITECTURE.md`, `docs/MILESTONES.md`, `docs/M0-SPEC.md`

One PR is fine given the size (192 code occurrences as of the post-merge recount, no behavioral change) — this doesn't need per-step PRs the way a risky migration would.

## 4. Verification

No new tests — this changes names, not behavior. Definition of done: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e`, `helm lint charts/engine && bash charts/engine/tests/run.sh` all green with zero logic changes (a reviewer should be able to confirm the diff is rename-only by skimming for anything that isn't an identifier/string/comment change).
