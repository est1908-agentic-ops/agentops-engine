# Shared PR Landing and Project-Controlled Auto-Merge

**Date:** 2026-07-15

## Summary

AgentOps will converge AgentOps-created pull requests and explicitly enrolled
existing pull requests on one durable `prLanding` workflow. The workflow owns
review, repair, verification, PR babysitting, merge-policy evaluation, and the
final merge attempt.

Projects control merge authority with a disabled-by-default `autoMerge` mode.
AgentOps performs eligible merges through the SCM port after validating the
exact PR head. It does not enable GitHub's native auto-merge feature and does
not bypass repository protections.

## Vision alignment

This design deliberately extends `docs/software-lifecycle-vision.md`. The
vision is updated in the same change to make PR landing a first-class SLDS
workflow and to define the policy-controlled transition from merge-ready to
merged.

- It implements the existing principle that project policy determines merge
  authority.
- It preserves one quality bar by routing every supported PR source through
  verification, review, repair, and babysitting.
- It replaces parallel landing behavior with one reusable workflow.
- It keeps autonomous work bounded by brakes and permits a manual outcome.
- It adds landing as the common terminal lifecycle for AgentOps-created and
  explicitly enrolled PRs.

## Goals

- Auto-merge eligible AgentOps PRs after the shared quality gates pass.
- Let a human enroll an existing PR by applying an `automerge` label.
- Let a human prevent merging with an absolute `automerge:disable` veto.
- Keep auto-merge disabled unless a project explicitly enables it.
- Guarantee that only the exact validated PR head can be merged.
- Give one workflow exclusive mutation ownership of a PR branch.
- Preserve a clear manual merge-ready outcome when policy withholds authority.

## Non-goals

- Enabling or delegating to GitHub native auto-merge.
- Bypassing branch protections, rulesets, required approvals, merge queues, or
  provider permissions.
- Automatically enrolling every externally created PR in a repository.
- Configuring a merge strategy in `agentops.json`.
- Changing the SLDS human-authority boundary: project policy continues to grant
  or withhold merge authority.

## Project policy

`ProjectConfigSchema` gains the strict field:

```json
{
  "autoMerge": "disabled"
}
```

The allowed values are:

- `disabled`: AgentOps never merges. This is the default and is an absolute
  project-level kill switch.
- `label`: a PR is merge-eligible only while it carries the `automerge` label.
- `all`: every AgentOps-created PR is merge-eligible. An existing external PR
  can still be enrolled explicitly with the `automerge` label.

The `automerge:disable` label is an absolute veto in all modes. When the veto is
present, the workflow finishes with a manual merge-ready outcome and leaves the
PR open. Removing the label does not revive a completed workflow; a later
`automerge` enrollment event may start a new landing run if project policy
allows it.

The complete authority table is:

| Mode       | AgentOps-created PR                 | Existing PR with `automerge`          | Any PR with `automerge:disable` |
| ---------- | ----------------------------------- | ------------------------------------- | ------------------------------- |
| `disabled` | Manual                              | Ignored                               | Manual                          |
| `label`    | Eligible only with `automerge`      | Enrolled and eligible                 | Manual                          |
| `all`      | Eligible                            | Enrolled and eligible                 | Manual                          |

For `label` mode, removing `automerge` before the merge attempt has the same
authority result as never applying it: the validated PR finishes manual
merge-ready.

## Architecture

### One landing workflow

`prLanding` is a workflow that can run either as a child of `devCycle` or as a
standalone workflow for an existing PR. It exclusively owns:

- the PR worktree while it is running;
- internal full verification and review;
- repairs prompted by failed gates or actionable review feedback;
- PR feedback and CI babysitting;
- current-head and current-label validation;
- merge-policy evaluation;
- the direct SCM merge attempt;
- cleanup and the terminal landing outcome.

The existing `devCyclePrRepair` implementation is absorbed into `prLanding` or
retained only as a compatibility wrapper. `devCycle` no longer retains a
second, competing PR repair and babysit loop after handing off the PR.

### AgentOps-created PR path

```text
devCycle
  -> implements, verifies, and reviews the requested change
  -> pushes and opens a PR marked agentops:managed
  -> starts prLanding as a child
  -> transfers worktree ownership to the child
  -> awaits and reports the child's terminal landing outcome
```

The parent passes the serialized `workspaceRef`, branch, project and repository
identity, PR reference, configuration, and the current quality evidence. A
Temporal child workflow does not share process memory or a filesystem with its
parent. Reuse works because workflow activities receive the explicit
`workspaceRef`, and both worker and agent-job pods mount the same worktree and
Git-cache PVCs at the same paths.

Once the handoff succeeds, `devCycle` must neither mutate nor clean the
worktree. `prLanding` is the sole owner and cleans it exactly once on a terminal
path.

### Existing PR path

```text
human applies automerge
  -> signed pull_request/labeled webhook reaches the gateway
  -> gateway resolves the registered project and current policy
  -> disabled mode is acknowledged without starting work
  -> otherwise gateway starts standalone prLanding
  -> prLanding checks out the PR head into its own worktree
  -> prLanding runs full verification, review, repair, and landing
```

An external PR is reviewed before it is repaired. The initial sequence is
`full_verify -> review`; `implement` runs only when a gate or actionable
feedback identifies work to do. Every repair is followed by full verification
and review before the workflow can return to landing.

### Exclusive PR ownership

Each PR has a deterministic landing workflow identity derived from the
repository and PR number. AgentOps-created PRs carry the `agentops:managed`
machine label, so their label webhooks are routed to the child owned by
`devCycle` rather than starting a competing standalone execution.

Review and relevant label events signal the existing landing execution. Start
and signal operations use Temporal conflict handling so duplicate or reordered
webhooks cannot create two active mutation owners for the same PR. After a
landing execution completes, a later valid enrollment may create a new run for
the same PR; only one run may be active at a time.

## Contracts and package boundaries

All new cross-package shapes are defined and zod-validated in
`packages/contracts` before use:

- `AutoMergeModeSchema` for `disabled | label | all`;
- `PrLandingInputSchema` for both child and standalone entry paths;
- `PrLandingStateSchema` and a terminal outcome enum;
- a PR snapshot schema containing the exact head SHA, labels, open/draft state,
  CI state, review-thread state, and provider mergeability evidence;
- merge request and merge result schemas.

`PrLandingStateSchema` is separate from `DevCycleStateSchema`. Its terminal
outcomes are:

- `merged`: AgentOps merged the exact validated head;
- `merge-ready-manual`: all quality gates passed, but policy withheld merge
  authority;
- `blocked`: brakes were reached or the provider structurally refused landing;
- `failed`: the workflow encountered an unrecoverable failure;
- `cancelled`: a human cancelled the workflow.

The fixed `StageSchema` and `TaskStatusSchema` vocabularies are not expanded
implicitly. Any necessary additions are explicit contract changes with tests.

`packages/policies` owns a pure, exhaustive merge-authority decision function.
It receives only `mode`, `agentCreated`, and current labels. No provider API or
Temporal type enters the policy package.

`ScmPort` gains provider-neutral operations to obtain a current PR snapshot and
merge an exact head. The GitHub adapter alone imports and calls GitHub APIs.

## Quality gates and data flow

The landing loop is:

```text
read current PR head
  -> establish or refresh the worktree
  -> full verification
  -> independent review
  -> repair when needed
  -> full verification and review after every repair
  -> babysit CI and external review feedback
  -> read a fresh PR snapshot
  -> evaluate current labels and project authority
  -> merge the exact validated SHA or finish manual merge-ready
```

Quality evidence is always associated with a head SHA. Any new commit,
including a human push, invalidates earlier evidence and returns the workflow to
verification and review.

Immediately before merging, `prLanding` reads a fresh snapshot and confirms:

- the PR remains open and is not a draft;
- the head SHA equals the internally verified SHA;
- CI is green and review feedback is resolved;
- current labels still grant authority and do not contain the veto.

The merge request includes the expected head SHA. This closes the race between
the final snapshot and the merge call: a changed head is not merged.

## Direct merge semantics

AgentOps performs the merge itself through `ScmPort.mergePr`. It does not
enable GitHub native auto-merge.

No merge method is supplied by project configuration. The GitHub adapter omits
`merge_method`, which uses GitHub's API default (currently a merge commit).
Repository configuration and rules remain authoritative and may reject that
method. Repositories that require a merge queue, disallow the selected API
default, require unmet approvals, or otherwise prohibit the operation are not
bypassed.

The merge request includes the expected PR head SHA. A provider response that
the head changed returns control to the landing loop for revalidation. An
already-merged response is idempotent success only when the provider confirms
that the expected head was the merged head.

## Error handling and brakes

- Network errors, provider 5xx responses, and other transient activity failures
  use bounded Temporal activity retries.
- A head-SHA conflict is safe concurrency, not failure; the workflow reads the
  new head and starts quality validation again.
- Pending CI or reviews remain in bounded babysitting.
- Repeated no-progress polling or exhausted repair limits enter the existing
  human brake pattern.
- A provider permission failure, required merge queue, unsupported merge
  method, or other structural merge refusal produces `blocked` with a specific
  reason; it is not retried indefinitely.
- `automerge:disable`, a missing required `automerge` label, or `disabled`
  policy produces `merge-ready-manual`, not `blocked` or `failed`.
- Cancellation stops further mutation, performs owned-worktree cleanup, and
  returns `cancelled`.

## Trigger and event behavior

The gateway adds parsing for signed GitHub `pull_request` events with action
`labeled`. Only the `automerge` label enrolls an external PR. The gateway:

1. validates the webhook signature and payload;
2. resolves the managed project by repository;
3. resolves current project configuration;
4. acknowledges without starting when mode is `disabled`;
5. routes an `agentops:managed` PR to its existing child landing execution;
6. starts or signals the deterministic standalone landing execution otherwise.

Submitted review events and relevant `automerge` or `automerge:disable` label
changes wake the active landing workflow. Polling remains the durable fallback,
so a missed webhook does not permit an unsafe merge or strand an active run.

## Observability

The landing state and result expose:

- project, repository, and PR reference;
- current and last-validated head SHAs;
- whether the PR was AgentOps-created or externally enrolled;
- project auto-merge mode observed for the run;
- current phase and brake reason;
- verification, repair, and babysit counters;
- terminal outcome and provider merge result where applicable.

Logs and traces identify the parent `devCycle` for child executions. The UI may
render the new state later, but the workflow query and Temporal result are the
initial observability contract.

## Testing

### Contracts and policy

- `autoMerge` defaults to `disabled` and rejects unknown values.
- The authority policy exhaustively covers every mode, provenance, positive
  label, veto label, and relevant combination.
- The veto always wins.
- Disabled mode always withholds authority.

### Workflow tests

- A child adopts the parent's explicit `workspaceRef`, and only the child
  cleans it after handoff.
- A standalone run prepares and cleans its own PR-head worktree.
- External enrollment performs full verification and review before merge.
- Every repair is followed by full verification and review.
- An unchanged, eligible, green head merges exactly once.
- Disabled, missing-label, removed-label, and veto cases finish manual
  merge-ready without calling merge.
- A veto added immediately before the merge attempt prevents merging.
- A changed head invalidates evidence and re-enters validation.
- Duplicate and reordered webhook signals produce one active mutation owner.
- Transient failures retry, while structural refusals block.
- Cancellation and every terminal branch clean only the owned worktree.

### Gateway and port tests

- Signed `pull_request/labeled` payloads enroll only the intended label and
  registered repositories.
- Disabled mode does not start a workflow.
- AgentOps-managed and external PR events route correctly.
- The GitHub merge request contains the expected SHA and omits
  `merge_method`.
- GitHub success, already-merged, head-conflict, cannot-merge, permission, and
  transient responses map to the provider-neutral result contract.

### Required verification

The implementation must pass:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
```

The e2e suite is mandatory because the change touches contracts, policies,
activities, ports, gateway behavior, and Temporal workflows.

## Documentation impact

- Document `autoMerge` and both labels in project configuration documentation.
- Document the `pull_request` webhook event requirement for external
  enrollment and label changes.
- Update workflow and Temporal architecture documentation for `prLanding` and
  worktree ownership transfer.
- Update `docs/software-lifecycle-vision.md` in the same change to define
  `prLanding` and policy-controlled merging as part of the target SLDS.
