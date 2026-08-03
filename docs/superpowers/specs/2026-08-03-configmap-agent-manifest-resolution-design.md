# ConfigMap-first activity config resolution

**Date:** 2026-08-03

**Scope:** Make engine activities use the managed-project ConfigMap's
`agentops.json` before falling back to the target repository.

## Problem

The worker loads the mounted `managed-projects` ConfigMap into a
`FileManagedProjectStore`, and the control API correctly exposes that stored
configuration. Two activity methods bypass the store, however:

- `loadAgentsManifest` calls `loadProjectConfig(scm, repo)` directly. Config
  sync therefore sees no agents when a deliberately untouched product repo has
  no in-repo `agentops.json`, even though the platform ConfigMap declares them.
- `resolveRepoConfig` makes the same direct call after confirming that the repo
  is registered. Development, bug-hunt, repair, and platform workflows can
  consequently receive repository defaults instead of the platform-owned
  configuration.

For `employee-hub-monorepo`, the resulting config-sync history contains an
empty manifest and an empty reconcile plan. Manually created schedules are not
a workaround because the next reconciliation deletes schedules absent from the
declared set.

## Decision

Reuse the existing `resolveProjectConfig` boundary in both activity methods.
Add optional `ManagedProjectRegistryDeps` to `ActivityDependencies`, pass the
worker's already-constructed `managedProjectDeps` into `createActivities`, and
call:

```ts
resolveProjectConfig(deps.managedProjectDeps, deps.scm, repo);
```

The dependency stays optional for local and test callers. With no managed store,
or when a registered project has no ConfigMap `agentops.json`, the resolver
preserves the existing in-repository fallback. `resolveRepoConfig` retains its
current unregistered-repository short circuit, so the fix does not broaden SCM
or project authorization.

Alternatives rejected:

- Embedding full configuration in `ResolvedProjectEntry` duplicates the store
  model in a cross-package contract and expands the change unnecessarily.
- Calling `store.get` independently in each activity duplicates the precedence
  rules already centralized and tested by `resolveProjectConfig`.
- Adding `.agentops/agentops.json` to product repositories reverses the platform
  decision that those repositories may remain untouched.

## Data flow

```text
mounted managed-projects ConfigMap
  -> FileManagedProjectStore
  -> managedProjectDeps
  -> createActivities
  -> resolveProjectConfig
       -> stored config when non-null
       -> repository agentops.json fallback otherwise
  -> loadAgentsManifest / resolveRepoConfig
```

## Verification

Regression tests at the activity boundary will prove that:

1. `loadAgentsManifest` returns agents and worker configuration from the managed
   store while the target repo has no config file, and performs no SCM read.
2. `resolveRepoConfig` returns the managed store's complete project config and
   performs no SCM read.
3. A managed project with `config: null` still falls back to the repository
   config.
4. An unregistered repo remains short-circuited without an SCM read.
5. Worker wiring supplies the same managed-project dependencies used to build
   the boot-time registry.

The affected activity and worker tests run first, followed by repository lint,
typecheck, unit tests, policy coverage, build, and e2e.

## Rollout

This is engine worker code only. Merging publishes a new immutable worker image,
which the platform's image updater can adopt. No Helm template changes are
required, so the engine chart `targetRevision` does not need a bump. After the
new image is deployed, trigger config reconciliation and confirm the two
platform-owned employee-hub agent schedules are created paused as declared.

## SLDS alignment

The change restores the existing SLDS principles rather than changing them:
configuration remains preferred, projects remain extensible without modifying
their repositories, and recurring workflows can enter the shared lifecycle.
No SLDS documentation change is required.
