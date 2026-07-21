# Project configuration (`agentops.json`)

`agentops.json` is the single, git-committed, PR-reviewed configuration file the
engine reads from a managed repo. It tells the engine how to build the verify
environment, which model tiers each stage routes to, what budget brakes to
enforce, whether it may merge PRs, and — via its [`agents`](#the-agents-block) and
optional [`worker`](#the-worker-block) blocks — which workflows to schedule for the
project. Everything in it is optional.

## Location

Read from the repository root over the SCM port, first present wins:

1. `agentops.json`
2. `.agentops.json`
3. `.agentops/settings.json`
4. `.agentops/agentops.json`

A missing file — or an empty `{}` — resolves to full defaults (see
[Defaults](#defaults)). Invalid JSON fails the run with
`InvalidProjectConfigError`; it is never silently ignored. Unknown top-level keys
are dropped, not rejected.

## Schema

```jsonc
{
  // Verify environment — how the agent-runner Job is built and how work is checked.
  "image": "ghcr.io/acme/agent-runner:sha", // agent-runner image override; default: worker's AGENT_RUNNER_IMAGE
  "services": [
    {
      "name": "postgres", // sidecar started next to the agent for verify
      "image": "postgres:16",
      "env": { "POSTGRES_PASSWORD": "test" }, // optional
      "readiness": { "type": "tcpSocket", "port": 5432 }, // or { "type": "exec", "command": ["pg_isready"] }
    },
  ],
  "initCommands": ["pnpm install"], // run once to set up the workspace before verify
  "fastVerifyCommands": ["pnpm lint", "pnpm typecheck"], // cheap gate (lint/typecheck)
  "fullVerifyCommands": ["pnpm test"], // full gate (tests/e2e)

  // Pipeline shape.
  "stages": {
    "assess": true, // toggle optional stages
    "triage": false,
  },

  // Model routing — each stage picks a named tier, not a concrete model.
  "routing": {
    "implement": { "tier": "implementation", "effort": "high" },
    "review": { "tier": "review" },
    // context | assess | design | plan | implement | full_verify | review | pr | pr_babysit | bughunt | agent
  },
  "escalation": { "tier": "escalation" }, // tier used when a stage escalates
  "tiers": {
    // project-local tier definitions; on a name collision with a global tier, the project wins
    "implementation": [{ "backend": "claude", "model": "claude-opus-4-8", "effort": "high" }],
  },

  // Brakes and timeouts.
  "brakes": {
    "maxImplementAttempts": 3,
    "maxIterations": 6,
    "maxTokens": 200000,
    "maxBabysitRounds": 5,
  },
  "timeouts": {
    "implement": { "idleTimeoutMs": 600000, "timeoutMs": 3600000 },
    // same stage keys as routing
  },

  // Merge authority.
  "autoMerge": "disabled", // "disabled" | "label" | "all"

  // Scheduled workflows and the optional Tier-2 worker (former agents.json).
  "agents": [{ "name": "nightly-bughunt", "workflow": "whiteboxBugHunt", "schedule": "0 2 * * *" }],
  "worker": {
    "image": "gitactions.example.top/acme/agentops-worker:sha",
    "externalSecrets": ["rollbar-token"],
  },
}
```

## Fields

**Verify environment**

- `image` — agent-runner image for this project's Jobs. Defaults to the worker's
  `AGENT_RUNNER_IMAGE`.
- `services` — sidecar containers started alongside the agent during verify. Each
  has `name`, `image`, optional `env`, and a `readiness` probe that is either
  `{ "type": "exec", "command": [...] }` or `{ "type": "tcpSocket", "port": <n> }`.
- `initCommands` — commands to prepare the workspace (install deps, migrate) before
  verify runs.
- `fastVerifyCommands` / `fullVerifyCommands` — the two verify gates. The engine runs
  them during `devCycle`, `devCyclePrRepair`, and PR landing.

**Model routing**

- `routing` — per-stage `{ tier, effort? }`. Stages: `context`, `assess`, `design`,
  `plan`, `implement`, `full_verify`, `review`, `pr`, `pr_babysit`, `bughunt`,
  `agent`. A tier resolves to an ordered `ModelRef[]` (primary + rate-limit fallback
  chain); `effort` overrides the tier's default effort for that stage.
- `escalation` — `{ tier }` used when a stage escalates to a stronger model.
- `tiers` — project-local tier definitions mapping a tier name to a `ModelRef[]`. A
  `ModelRef` is `{ backend, model, effort? }` where `backend` is one of `claude`,
  `cursor`, `pi`, `codex`, `stub`, `platform`. On a name collision with a global
  tier, the project-local definition wins.

**Brakes and timeouts**

- `brakes` — budget stops: `maxImplementAttempts`, `maxIterations`, `maxTokens`,
  `maxBabysitRounds`. Partial overrides merge onto the defaults.
- `timeouts` — per-stage `{ idleTimeoutMs?, timeoutMs? }`, same stage keys as
  `routing`.

**Pipeline**

- `stages` — booleans toggling optional stages (`assess`, `triage`).

**Merge authority**

- `autoMerge` — `"disabled"` (default), `"label"`, or `"all"`. See
  [Auto-merge](#auto-merge).

## The `agents` block

`agents` is an array that schedules built-in workflows (Tier 1) — and, alongside a
[`worker`](#the-worker-block), a project's own custom workflows (Tier 2). It
replaces the former standalone `agents.json`.

### Agent entry schema (strict)

```jsonc
{
  "name": "nightly-bughunt", // kebab-case, DNS-safe, unique per project
  "workflow": "whiteboxBugHunt", // built-in workflow name (or a project Tier-2 workflow)
  "schedule": "0 2 * * *", // 5-field cron, or the literal "continuous"
  "input": { "focus": "auth" }, // per-workflow, validated for built-ins
  "enabled": true, // default true; false pauses the Schedule
  "timezone": "UTC", // default "UTC"
  "overlap": "skip", // "skip" | "bufferOne" | "allow"; default "skip"
  "taskQueue": "proj-acme", // optional; Tier-2 agents target their worker's queue
}
```

Validation rules:

- Unknown per-agent keys are rejected (each entry is strict).
- `name` matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` and is unique within the file.
- `schedule` is a 5-field cron or `"continuous"`.
- `input` is validated against the named workflow's manifest schema when known (Tier 1
  built-ins). Unknown workflows pass input through (Tier 2).
- A malformed `agents` block fails the whole config parse (no partial apply); existing
  Schedules are left as-is.

### Built-in catalog

- `whiteboxBugHunt({ repo, focus? })`
  - Input schema: `{ focus?: string }`
  - Runs a read-only agent, emits `FINDINGS: [...]` JSON, files `bug` + `whitebox` labeled issues.
  - Deduplicated by `filed_findings(project, fingerprint)` using `findingFingerprint({ location, title })`.

More Tier-1 finders (e.g. `qaProbe`) are planned but not yet implemented.

`"continuous"` schedules run the agent as a singleton workflow instead of a Temporal Schedule (used by Tier-2 workers).

### Schedule identity and lifecycle

- Schedule ID: `agent:<project>:<name>`
- Reconciler (`ConfigSync`):
  - Reads `agentops.json` via SCM.
  - Diffs declared vs. live Schedules for the project prefix.
  - Create missing, update changed (cron/workflow/input/tz/overlap), delete orphans, pause/resume on `enabled`.
- `enabled: false` → `pause()` (reversible). Entry removal → `delete()`.
- `overlap: "skip"` is the default (no stacking). `catchupWindow` ~1h.

### Prompt provenance

`whiteboxBugHunt` (and future built-ins) record on `agent_run_stats` and OTel spans:

- `promptHash` (sha256 of rendered prompt)
- `promptSource` (e.g. `builtin:whitebox-bughunt.md`)
- `project`, `workflowType`

### Search attributes

The engine registers and stamps three custom Keyword search attributes for Schedules and continuous agent workflows:

- `project`
- `agentName`
- `workflowType`

The engine worker **auto-registers** these in its namespace at startup (idempotent), so there's no manual pre-deploy step — Temporal would otherwise reject a Schedule create that references an unregistered attribute. `scripts/register-search-attributes.sh` remains as a manual fallback for bootstrapping a namespace by hand. They enable filtering/listing per project or per-agent-instance in the UI, cost dashboards, and control surfaces.

## The `worker` block

`worker` declares a project's **Tier-2** worker — present only when the project ships
its own Temporal workflows. A config with `agents` but no `worker` is Tier-1 (its
agents run on the engine's shared queue).

```jsonc
{
  "image": "gitactions.example.top/acme/agentops-worker:sha", // project-built worker image (repo:tag or repo@digest)
  "taskQueue": "proj-acme", // optional; defaults to proj-<project>
  "replicas": 1, // default 1
  "externalSecrets": ["rollbar-token"], // K8s Secret *names* (never values)
}
```

The gateway's ArgoCD ApplicationSet plugin generator reads this block to deploy the
generic `project-worker` Helm chart. Full walkthrough:
[authoring-project-workflows.md](authoring-project-workflows.md) and
[project-worker-deployment.md](project-worker-deployment.md); reference project at
[project-worker/](project-worker/).

## Auto-merge

Auto-merge is `disabled` by default. Modes:

| Mode       | Behavior                                            |
| ---------- | --------------------------------------------------- |
| `disabled` | Kill switch — never auto-merge (default).           |
| `label`    | Merge when the PR carries the `automerge` label.    |
| `all`      | Merge AgentOps-created PRs without needing a label. |

The `automerge:disable` label always wins, regardless of mode. AgentOps-managed PRs
carry the `agentops:managed` label. Enrolling **external** PRs (not created by
AgentOps) requires the repo's GitHub webhook to also send `Pull request` and
`Pull request review` events, in addition to `Issues`.

## Defaults

A missing config resolves to:

```jsonc
{
  "stages": {},
  "routing": {
    "context": { "tier": "smart" },
    "assess": { "tier": "smart" },
    "design": { "tier": "smart", "effort": "medium" },
    "plan": { "tier": "smart" },
    "implement": { "tier": "implementation", "effort": "high" },
    "full_verify": { "tier": "smart", "effort": "high" },
    "review": { "tier": "review" },
  },
  "escalation": { "tier": "escalation" },
  "brakes": {
    "maxImplementAttempts": 3,
    "maxIterations": 6,
    "maxTokens": 200000,
    "maxBabysitRounds": 5,
  },
  "autoMerge": "disabled",
}
```

`stages`, `routing`, and `brakes` are merged one level deep over these defaults, so a
partial override (e.g. only `routing.implement`, or only `brakes.maxTokens`) keeps the
rest of the defaults. `image`, `services`, `initCommands`, the verify commands,
`agents`, and `worker` have no default — they are absent unless the project sets them.
