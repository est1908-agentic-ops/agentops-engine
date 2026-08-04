# Provider-aware Linear project credentials

Status: implemented · 2026-08-04 · Owner: Artem

## Problem

The ConfigMap-backed managed-project path names separate GitHub and Linear
Secrets, but `KubeTokenResolver` always reads `GITHUB_TOKEN`. A Linear API key
therefore has to masquerade under a GitHub key. The same project contract also
requires `linearTriggerLabelId`, coupling Linear issue operations to optional
webhook-triggered task creation.

## Decision

The managed-project boundary selects the provider-specific Secret key:

- `tokenSecret` resolves `GITHUB_TOKEN`.
- `linearTokenSecret` resolves `LINEAR_API_TOKEN`.

`KubeTokenResolver` accepts the key explicitly, caches by Secret name plus key,
and reports both values when a Secret read or key lookup fails. The CLI local
development path reads that same requested key from the environment.

`linearTriggerLabelId` becomes optional in stored and resolved Linear project
contracts. `linearTeamKey` and `linearTokenSecret` remain necessary for Linear
issue operations. When the global Linear webhook route is enabled but a resolved
project has no trigger label, the gateway acknowledges the event without
starting `devCycle`. The gateway checks this stored metadata before resolving
either credential, so a disabled trigger has no Kubernetes Secret dependency.

The `linear:TEAM-number` tracker reference remains unchanged. It is an explicit
provider tag at a serialized workflow boundary, not inference from object shape.

`FileManagedProjectStore` reads the mounted directory for each lookup instead of
caching the first result for the process lifetime. The gateway gets a fresh view
per webhook request. The worker reloads the registry and atomically replaces its
tracker, SCM, and workspace dispatch wiring every minute, retaining the previous
wiring if refresh fails. Kubelet's projected ConfigMap updates therefore become
visible without coordinating a restart across the separate engine and
managed-projects Argo CD Applications.

## SLDS alignment

This restores the existing issue-to-`devCycle` lifecycle for Linear-tracked
projects without changing lifecycle stages, quality gates, or human authority.
It separates credential lookup and webhook initiation configuration; it does not
introduce a parallel delivery path.

## Verification

Tests cover key selection and cache isolation, contextual Secret errors, local
environment selection, Linear project parsing without a trigger label, resolved
type optionality, file-store refresh, live worker-wiring replacement, and gateway
acknowledgement without a Temporal workflow start.
The repository lint, typecheck, unit, policy-coverage, and end-to-end suites must
remain green.
