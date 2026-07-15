# agents.json — Tier 1 custom agent manifest

`agents.json` is a git-committed, PR-reviewed manifest that schedules built-in workflows for a project. It is the configuration source of truth for Tier 1 custom agents.

Location: repository root (alongside or near `agentops.json`).

## Schema (strict)

```jsonc
{
  "agents": [
    {
      "name": "nightly-bughunt", // kebab-case, DNS-safe, unique per project
      "workflow": "whiteboxBugHunt", // built-in workflow name
      "schedule": "0 2 * * *", // 5-field cron, or the literal "continuous"
      "input": { "focus": "auth" }, // per-workflow, validated for built-ins
      "enabled": true, // default true; false pauses the Schedule
      "timezone": "UTC", // default "UTC"
      "overlap": "skip", // "skip" | "bufferOne" | "allow"; default "skip"
    },
  ],
}
```

Validation rules:

- Unknown top-level or per-agent keys are rejected (z.strict()).
- `name` matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
- Names are unique within the manifest.
- `schedule` is a 5-field cron or `"continuous"`.
- `input` is validated against the named workflow's manifest schema when known (Tier 1 built-ins). Unknown workflows pass input through (Tier 2).
- A malformed `agents.json` causes the entire reconcile for that project to fail (no partial apply). Existing Schedules are left as-is.

## Built-in catalog

- `whiteboxBugHunt({ repo, focus? })`
  - Input schema: `{ focus?: string }`
  - Runs a read-only agent, emits `FINDINGS: [...]` JSON, files `bug` + `whitebox` labeled issues.
  - Deduplicated by `filed_findings(project, fingerprint)` using `findingFingerprint({ location, title })`.

More Tier-1 finders (e.g. `qaProbe`) are planned but not yet implemented.

`"continuous"` schedules run the agent as a singleton workflow instead of a Temporal Schedule (used by Tier-2 workers).

## Schedule identity and lifecycle

- Schedule ID: `agent:<project>:<name>`
- Reconciler (`ConfigSync`):
  - Reads `agents.json` via SCM.
  - Diffs declared vs. live Schedules for the project prefix.
  - Create missing, update changed (cron/workflow/input/tz/overlap), delete orphans, pause/resume on `enabled`.
- `enabled: false` → `pause()` (reversible). Entry removal → `delete()`.
- `overlap: "skip"` is the default (no stacking). `catchupWindow` ~1h.

## Prompt provenance

`whiteboxBugHunt` (and future built-ins) record on `agent_run_stats` and OTel spans:

- `promptHash` (sha256 of rendered prompt)
- `promptSource` (e.g. `builtin:whitebox-bughunt.md`)
- `project`, `workflowType`

## Search attributes

The engine registers and stamps three custom Keyword search attributes for Schedules and continuous agent workflows:

- `project`
- `agentName`
- `workflowType`

The engine worker **auto-registers** these in its namespace at startup (idempotent), so there's no manual pre-deploy step — Temporal would otherwise reject a Schedule create that references an unregistered attribute. `scripts/register-search-attributes.sh` remains as a manual fallback for bootstrapping a namespace by hand. They enable filtering/listing per project or per-agent-instance in the UI, cost dashboards, and control surfaces.

## Notes

- Removing or editing `agents.json` is the supported way to manage automation.
- Manual edits in the Temporal UI are overwritten on next reconcile.
- Tier 2 (project-authored workflows via `@agentic-ops/engine-sdk` + a per-project worker) is documented in [authoring-project-workflows.md](authoring-project-workflows.md) and [project-worker-deployment.md](project-worker-deployment.md).
- Automatic issue → `devCycle` "fix" wiring for auto-created bug issues (Gateway `issues.opened` + an `agent:fix` label) is planned but not yet implemented.

See [Authoring project workflows](authoring-project-workflows.md) for the full
capability ladder.
