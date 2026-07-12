# Agent-workflow DSL — interpreter, domain steps & workflow sourcing (sub-project 1) — design

Status: draft v1 · 2026-07-12 · Owner: Artem
Tracks: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30) ("Custom agent config in the JSON and database") · follow-ons in [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31)
Relates to: ARCHITECTURE.md §5.9.1 (role-as-manifest), §6.1 (project-defined triggers & jobs), §5.10 (edits land as PRs), §8.1 M8 (roles as config) — this supersedes M8's git-backed `RoleManifest` with a DSL-interpreter model.

## 1. Why

Issue #30 asks for custom agents ("every night bughunt → PR", "every hour review PRs → merge", "QA → file issue", "sweep issues → fix", "agents invoke agents") **defined as JSON, like devCycle but at the data level** — no engine code change and no engine redeploy to add or tune an agent.

Today a workflow is a hand-written TypeScript function (`packages/workflows/src/dev-cycle.ts`, ~360 lines; `platform.ts`). Its *shape* — the stage sequence, the repair loop, the babysit loop — is hardcoded; JSON config (`ProjectConfig`) only tunes knobs on that fixed shape. There is no way to define a *new* pipeline shape without writing and deploying TS. There are no Temporal Schedules, no `RoleManifest`, no `triggers`/`jobs` machinery anywhere yet.

**On "in the database" (a resolved decision).** #30 said "defined in databases not in the code." We read the intent as *not hardcoded TS requiring an engine build* — and resolve it to **git-first JSON**, not a DB. A DSL that can merge PRs, spawn devCycles, file issues, and invoke other agents is high-blast-radius; the architecture already insists such config be reviewable ("edits land as PRs, not direct writes", §5.10) and agent-improvable ("a normal project PR — reviewable, revertable, improvable by agents themselves", §6.1). So definitions live in git and reach the engine as data (no TS rebuild), with a **pluggable source** so a DB override can be added later for repos you don't control. See §4.6.

The full ask is large and decomposed into four sub-projects (§2). **This spec covers sub-project 1 only: the DSL, its interpreter, the step library, the validator, and the `WorkflowSource` resolver with its engine-built-in adapter** — the foundation everything else builds on.

## 2. Decomposition (context for scope)

| # | Sub-project | Delivers | This spec |
|---|---|---|---|
| **1** | **DSL + interpreter + built-in sourcing** | Zod DSL schema; a generic deterministic `interpret(input)` workflow; the step library (leaf + composite + control-flow); pure `evalExpr` + `validateDsl`; the `WorkflowSource` port + engine-built-in adapter; a `control` `run` route. | **← here** |
| 2 | Sourcing & invocation | Project-repo `WorkflowSource` adapter (`agentops/workflows/*.json` via `ScmPort.readFile`, reusing `load-project-config`); optional DB override adapter; `ConfigSync` reconciler; schedules (cron → Temporal Schedule) + triggers (webhook/label + a `workflowClosed` kind → start `interpret`). | #31 |
| 3 | New domain steps | The DSL verbs the 5 use cases need but that don't exist yet: `listOpenPrs`/`reviewPr`/`mergePr`, `listOpenIssues`, `qaProbe`, `createIssue`/`fileIssue` (no create-issue exists today), `recordHealCase`, `parseReproResult`. | #31 |
| 4 | Mission Control editing | UI to browse/edit DSLs with live `validateDsl` feedback and "run now"; **"save" opens a PR** (§5.10), not a direct write. | #31 |

## 3. Scope

**In scope:**
- `AgentWorkflowDslSchema` (`packages/contracts`) — the nested-tree DSL and its step vocabulary.
- The `interpret(input)` Temporal workflow (`packages/workflows`).
- The step library: leaf (`agent`, `agentParse`, `activity`, `policy`, `startChild`), composite (`preImplement`, `repairLoop`, `babysitPr`), control-flow (`sequence`, `parallel`, `branch`, `loop`, `forEach`, `waitSignal`) — **only what's needed to reproduce `devCycle`/`platform` plus `startChild`.**
- The bindings map + restricted expression evaluator (`evalExpr`, pure, in `policies`).
- `validateDsl` pure validator (`policies`).
- The `WorkflowSource` resolver interface + **the engine-built-in adapter** (`packages/workflows/dsl/*.json`).
- `control` `POST /api/workflows/:name/run` (resolve via `WorkflowSource`, start `interpret`).
- ARCHITECTURE.md / AGENTS.md updates sanctioning the model.

**Out of scope** (deferred to #31, not forgotten):
- **The database, entirely.** No `agent_workflows` table, no store, no CRUD. Definitions come from git via the `WorkflowSource` port. A DB *override* adapter may be added later for unowned repos (§4.6) — not in SP1.
- **The project-repo adapter** (`agentops/workflows/*.json`). SP1 ships only the built-in adapter; sourcing project workflows is SP2, alongside ConfigSync and the credential-gated repo read.
- **Schedules / triggers / reconciler** (SP2). SP1 launches runs only via the `run` route.
- **New domain steps** for PR-review, QA, issue-sweep, heal-case recording, issue creation (SP3).
- **Mission Control UI** (SP4).
- **DB-stored prompt content.** DSL steps reference prompt *refs* (`implement.md`); content resolves from `packages/prompts` as today.
- **Cutting real `devCycle`/`platform` trigger paths over to the interpreter.** The native workflows are untouched and keep serving live triggers; the DSL runs *alongside* as a parity proof. Deprecating the hand-written versions is a separate, later decision.

## 4. Binding design decisions

1. **Interpret at runtime; the DSL is workflow input.** The starter resolves the DSL to JSON and passes it *as input* to `interpret`, pinning it in Temporal history: a running workflow replays against the exact DSL it started with; new runs pick up the new version. Mirrors how `config` flows today (`TaskInput.config`). Codegen-to-TS was rejected — it reintroduces a build/deploy per change.

2. **The interpreter is versioned TS; the DSL is data.** The AGENTS.md determinism boundary (rule #1) holds because `interpret` is ordinary workflow code doing no I/O of its own — it only proxies activities and calls pure policies, exactly like `devCycle`. The DSL parameterizes control flow; it never introduces `Date.now()`, randomness, or timers.

3. **The §2 invariants live in composite steps, never in hand-wired JSON.** `repairLoop`, `babysitPr`, and `agentParse` are single DSL steps backed by the existing `policies` (`nextRepairAction`, `babysitDecision`, `parseVerdict`, `parsePlatformResult`, `pre-implement-stages`). A DSL author cannot dead-end `review`, skip open-PR-on-exhaustion, or defeat fail-safe parsing, because those decisions aren't expressible as primitive edges. Authors needing a custom loop use the `policy` leaf step to call a policy explicitly and `branch` on its result — flexible, still routed through the tested policy.

4. **Structured control-flow tree, not a goto-graph.** The DSL is a nested tree (`sequence`/`parallel`/`branch`/`loop`/`forEach` containing child steps), not flat nodes with `next` edges. Structured nesting lets the validator prove reachability and bounded termination statically; arbitrary gotos reintroduce the unreachable-node / infinite-loop / dead-end footguns the composites exist to prevent.

5. **The `Stage` enum stays the routing/telemetry dimension.** `agent`/`agentParse` steps carry a `stage` from the fixed `StageSchema` (`packages/contracts/src/stage.ts`). The DSL arranges, repeats, and omits stages freely, but a *new* stage *name* is still a code change (it must line up with `routing`, search attributes, `agent_run_stats`). AGENTS.md's "fixed vocabulary" rule is clarified, not removed.

6. **Git-first source of truth, behind a pluggable resolver.** Definitions live in git and reach the engine as data: **built-in + platform workflows** (`devCycle`, `self-heal`, `metaOptimize`) in the **engine repo** (`packages/workflows/dsl/*.json`), versioned in lockstep with the interpreter and steps they depend on; **project & "central" workflows** in a **project repo** (`agentops/workflows/*.json`) — a workflows-only "project" is just a project with no real `src/`. Resolution goes through a `WorkflowSource` port with precedence (`(DB override →) project repo → engine built-in`), so adding the project-repo/DB adapters later never touches the interpreter. SP1 ships the port + the built-in adapter only.

## 5. The DSL vocabulary

A DSL is a nested tree of steps. Three layers.

**Leaf steps** (one unit of work):

| Step | Shape | Notes |
|---|---|---|
| `agent` | `{ stage, prompt, routing?, effort?, promptContext?, result? }` | Wraps `runAgent`; records `agent_run_stats`; applies stage→model routing (`config.routing[stage]` unless overridden). |
| `agentParse` | `{ stage, prompt, parser, sentinel?, maxCalls?, promptContext?, result }` | `agent` + a **fail-safe parse with bounded retry**: runs up to `maxCalls` (default 2), parses each output with the named `parser` policy, returns the parsed payload; unparseable after retries fails safe (never silent-pass). Generalizes the pattern in **both** `devCycle` (`runVerdictStage` → `parseVerdict`) and `platform` (`parsePlatformResult`). `verdict` is just `agentParse` with `parser: "parseVerdict"`. |
| `activity` | `{ name, args?, result? }` | Raw escape hatch, dispatched by name against an allow-listed proxy (Temporal `bindings` pattern). Allowed: `runAgent`, `openPr`, `pushBranch`, `getIssue`, `commentOnIssue`, `labelIssue`, `getPrFeedback`, `prepareWorkspace`, `cleanupWorkspace`, `prepareScratchWorkspace`, `cleanupScratchWorkspace`, `resolveRepoConfig`, `recordStageResult`, `recordRunStats`. |
| `policy` | `{ name, args, result }` | Calls a pure policy by name (`nextRepairAction`, `babysitDecision`, `parseVerdict`, `parsePlatformResult`, `preImplementStages`, `resolveStageLimits`, `evaluateBrakes`). For building custom loops from primitives. |
| `startChild` | `{ workflow, input, wait? }` | **Agent-invokes-agent.** Starts another workflow (by `name`, resolved via `WorkflowSource`, or a built-in like `devCycle`) as a Temporal child (`executeChild`, as `platform.ts` already does); `wait: true` awaits its terminal state into `result`, `wait: false` fans it out. |

**Composite steps** (proven multi-step bundles — the crown jewels):

| Step | Shape | Backed by |
|---|---|---|
| `preImplement` | `{ config }` | `preImplementStages` → runs `context/assess/design/plan` per config toggles. |
| `repairLoop` | `{ implement, verify, review, brakes, escalation? }` | `implement → verify → review → nextRepairAction` decision tree, escalation-on-final-attempt, brakes, block-on-brake. Wires findings feedback into the implement prompt internally. (`verify`/`review` are `agentParse` configs.) |
| `babysitPr` | `{ prRef, maxRounds, onActionable }` | Durable poll → `getPrFeedback` → `babysitDecision`; feedback-hash dedupe; `onActionable` re-runs its sub-step. |

**Control-flow steps** (compose freely):

| Step | Shape | Notes |
|---|---|---|
| `sequence` | `{ sequence: Step[] }` | Run in order. |
| `parallel` | `{ parallel: Step[] }` | `Promise.all` of branches. |
| `branch` | `{ on: Expr, cases: Record<string, Step[]>, default?: Step[] }` | Evaluate `on`, dispatch by matched case key (`truthy`/`falsy` for booleans; verdict kinds `pass`/`fail`/`unparseable`; enum/status values). |
| `loop` | `{ until: Expr, maxIterations: number, body: Step[] }` | While-style. **`maxIterations` required** — validator rejects an unbounded loop. |
| `forEach` | `{ in: Expr, as: string, maxItems: number, body: Step[] }` | Iterate the array at `in`, binding each element to `as`. Bounded by **required** `maxItems`. The natural iterator for sweeps (review open PRs, file findings, fix issues). |
| `waitSignal` | `{ signal, onResume?: Step[] }` | The `clarify`/`resume` escape hatch as a step; blocks on `condition()`. |

Zod (illustrative — the union is recursive via `z.lazy`):

```ts
export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.object({ agent: AgentStepSchema }),
    z.object({ agentParse: AgentParseStepSchema }),
    z.object({ activity: ActivityStepSchema }),
    z.object({ policy: PolicyStepSchema }),
    z.object({ startChild: StartChildStepSchema }),
    z.object({ preImplement: PreImplementStepSchema }),
    z.object({ repairLoop: RepairLoopStepSchema }),
    z.object({ babysitPr: BabysitPrStepSchema }),
    z.object({ sequence: z.array(StepSchema) }),
    z.object({ parallel: z.array(StepSchema) }),
    z.object({ branch: BranchStepSchema }),
    z.object({ loop: LoopStepSchema }),
    z.object({ forEach: ForEachStepSchema }),
    z.object({ waitSignal: WaitSignalStepSchema }),
  ]),
);

export const AgentWorkflowDslSchema = z.object({
  name: z.string().min(1),
  schemaVersion: z.literal(1),
  input: z.array(z.string()).optional(),   // declared input binding names
  root: StepSchema,
});
export type AgentWorkflowDsl = z.infer<typeof AgentWorkflowDslSchema>;
```

## 6. `devCycle` and `self-heal` as DSL — the parity targets

The acceptance bar: these DSLs, run through `interpret`, reproduce today's `devCycle` and `platform` behavior (see §14).

**devCycle** (compact because the hard parts live inside `repairLoop`/`babysitPr`):

```jsonc
{ "name": "devCycle", "schemaVersion": 1,
  "input": ["taskId", "repo", "issueRef", "goal", "config"],
  "root": { "sequence": [
    { "branch": { "on": "$.config", "cases": {
        "falsy": [ { "activity": { "name": "resolveRepoConfig", "args": ["$.repo"], "result": "config" } } ] } } },
    { "activity": { "name": "prepareWorkspace", "args": ["$.taskId", "$.repo"], "result": "ws" } },
    { "branch": { "on": "$.issueRef", "cases": {
        "truthy": [ { "activity": { "name": "getIssue", "args": ["$.issueRef"], "result": "issue" } } ] } } },
    { "preImplement": { "config": "$.config" } },
    { "repairLoop": {
        "implement": { "stage": "implement", "prompt": "implement.md" },
        "verify":    { "stage": "full_verify", "parser": "parseVerdict", "sentinel": "FULL:",    "prompt": "full_verify.md" },
        "review":    { "stage": "review",  "parser": "parseVerdict", "sentinel": "VERDICT:", "prompt": "review.md" },
        "brakes": "$.config.brakes", "escalation": "$.config.escalation" } },
    { "activity": { "name": "pushBranch", "args": ["$.repo", "$.ws.workspaceRef", "$.ws.branch", "$.taskId"] } },
    { "activity": { "name": "openPr", "args": [ /* … */ ], "result": "pr" } },
    { "babysitPr": { "prRef": "$.pr.prRef", "maxRounds": "$.config.brakes.maxBabysitRounds",
        "onActionable": { "agent": { "stage": "implement", "prompt": "implement.md" } } } },
    { "activity": { "name": "cleanupWorkspace", "args": ["$.ws.workspaceRef", "$.repo"] } }
  ] } }
```

**self-heal** (a faithful port of `platform.ts` — `agentParse` + `forEach` + `startChild`):

```jsonc
{ "name": "self-heal", "schemaVersion": 1,
  "input": ["prompt", "hintRepos", "failedWorkflowId"],
  "root": { "sequence": [
    { "activity": { "name": "prepareScratchWorkspace", "args": ["$.failedWorkflowId"], "result": "ws" } },
    { "agentParse": { "stage": "platform", "prompt": "platform.md",
        "promptContext": { "prompt": "$.prompt", "hintRepos": "$.hintRepos" },
        "parser": "parsePlatformResult", "result": "diagnosis" } },
    { "activity": { "name": "cleanupScratchWorkspace", "args": ["$.ws.workspaceRef"] } },
    { "branch": { "on": "$.diagnosis.parseable", "cases": {
        "truthy": [
          { "forEach": { "in": "$.diagnosis.proposedFixes", "as": "fix", "maxItems": 5, "body": [
              { "activity": { "name": "resolveRepoConfig", "args": ["$.fix.repo"], "result": "cfg" } },
              { "branch": { "on": "$.cfg.registered", "cases": {
                  "truthy": [ { "startChild": { "workflow": "devCycle", "wait": false,
                      "input": { "taskId": "heal-$.fix.repo", "repo": "$.fix.repo",
                                 "goal": "$.fix.goal", "config": "$.cfg.config" } } } ] } } }
          ] } } ] } } }
  ] } }
```

Signals (`stop`/`cancel`/`clarify`/`resume`) are handled globally by the interpreter, not per-step. (`self-heal`'s `recordHealCase` calls are omitted here — that activity is SP3.)

## 7. Bindings & the expression model

Steps read from and write to a `bindings: Record<string, unknown>` map, seeded from workflow input. `result` writes a step's output under a key; other steps reference values via a **restricted expression language**:

- **Path refs** — `$.config.brakes.maxTokens`, `$.pr.prRef`, `$.fix.repo`. Dot/bracket path access into `bindings`. A bare string with no `$.` prefix is a literal (`bindings[arg] ?? arg`). Interpolation inside a string (`"heal-$.fix.repo"`) substitutes the path.
- **Predicates** (only where a condition is needed — `branch.on`, `loop.until`, `waitSignal`): `truthy`/`falsy` of a path, `eq(path, literal)`, `empty(path)` (for collections), and `and`/`or`/`not` over those.

**No arbitrary JS `eval`** — it would break determinism and open an injection surface into workflow code. The evaluator is a pure function `evalExpr(expr, bindings)` in `packages/policies`, exhaustively unit-tested. An unresolvable path is a validation error at write time and a hard, non-retryable failure at runtime (never a silent `undefined`).

## 8. Contracts (`packages/contracts`)

Only the DSL itself is a contract now — there is no DB row type. `AgentWorkflowDslSchema` (§5) plus the resolver's return shape:

```ts
export interface ResolvedWorkflow {
  name: string;
  source: 'builtin' | 'project' | 'db';   // provenance for logs/telemetry
  dsl: AgentWorkflowDsl;
}
```

The interpreter's input:

```ts
export const InterpretInputSchema = z.object({
  dsl: AgentWorkflowDslSchema,
  bindings: z.record(z.string(), z.unknown()),
});
```

## 9. Workflow sourcing (`WorkflowSource` port + built-in adapter)

Resolution happens in the **starter** (the `control` BFF here; the reconciler/gateway in SP2), not inside the workflow — the resolved DSL is passed as `interpret` input (§4.1).

```ts
export interface WorkflowSource {
  resolve(name: string, project?: string): Promise<ResolvedWorkflow | null>;
  list(project?: string): Promise<string[]>;
}
```

**SP1 ships one adapter: `BuiltinWorkflowSource`** — reads `packages/workflows/dsl/*.json` (bundled into the worker/control image), validates each with `validateDsl` at load, and serves them by `name`. `devCycle.json` and `self-heal.json` (§6) live here.

Precedence for the composed resolver is `(db →) project → builtin`; SP1 has only `builtin`, so the composed resolver is trivial today. The **project-repo adapter** (reads `agentops/workflows/*.json` via `ScmPort.readFile`, reusing `load-project-config.ts`, credential-gated so it resolves worker-side via an activity) and the optional **DB override adapter** are SP2 (#31). No adapter holds secrets — credentials still resolve through `managed_projects`.

## 10. Control route (`packages/control`)

One new route in `agent-workflow-routes.ts` (no CRUD — definitions are edited in git, not through the API):
- `POST /api/workflows/:name/run` — resolve the DSL via `WorkflowSource`, build the `interpret` input from the request body's bindings, `startWorkflow(interpret, …)`. Returns the workflow id.
- (`GET /api/workflows` / `GET /api/workflows/:name` to *list/read* resolved definitions may come with SP4's UI; not required for SP1.)

## 11. The interpreter workflow (`packages/workflows/src/interpret.ts`)

`interpret(input: InterpretInput)` where `input = { dsl, bindings }`.

Structure (parallels `dev-cycle.ts`):
- Re-validate the DSL at entry (`validateDsl`) — defense against a definition that changed shape between resolve and start.
- Seed `bindings` from `input.bindings`.
- Register the four global signal handlers (`stop`/`cancel`/`clarify`/`resume`) and a `state` query exposing a generic `InterpretedState` (`packages/contracts`): current step path, `status`, `blockReason`, and the reused counters (`implementAttempts`, `iterations`, `cumulativeTokens`, `babysitRounds`). Signal semantics identical to `devCycle` (a `budget-exceeded` block retries in place; a brake block relaxes on `resume`).
- Two proxy sets reused verbatim from `dev-cycle.ts`: the general activities proxy (`10 min`, `maximumAttempts: 5`) and the `runAgent`-only proxy (`35 min`, `15s` heartbeat).
- `execute(step, ctx)` recurses over the tree. `ctx` = `{ bindings, state, activities, agentActivities, signal-flags }`. Each step kind is one `switch` arm; composite steps delegate to helpers ported from `dev-cycle.ts`/`platform.ts` (the verdict/parse retry, the repair-loop body, the babysit-loop body, the `executeChild` fan-out) so the *same* code paths — not reimplementations — back both native workflows and the DSL. Raw `activity` steps dispatch through a name→proxy allow-list; unknown names are impossible (validator rejected them).

Determinism/versioning: behavior changes to a step implementation use Temporal `patched()`; `schemaVersion` gates the DSL shape (`interpret` refuses an unknown version). The DSL never changes mid-run (it's in history).

## 12. Validation (`packages/policies/src/validate-dsl.ts`, pure)

`validateDsl(dsl, { allowedActivities, allowedPolicies, allowedParsers }): ValidationResult`:
- zod parse against `AgentWorkflowDslSchema`.
- Every `activity.name` ∈ `allowedActivities`; every `policy.name` ∈ `allowedPolicies`; every `agentParse.parser` ∈ `allowedParsers`.
- Every `loop` has `maxIterations`; every `forEach` has `maxItems`; every composite loop (`repairLoop`/`babysitPr`) has its brake/`maxRounds`.
- Every expression path resolves to a declared `input` name, a `forEach` `as` binding in scope, or a `result` written by an earlier step (best-effort static dataflow check).
- `agent`/`agentParse` `stage` ∈ `StageSchema`.
- `schemaVersion` is known.

Runs in `BuiltinWorkflowSource` at load, in the SP2 sources at reconcile/CI time, and again at `interpret` entry (runtime defense). Exhaustively unit-tested — this is the safety net that makes data-defined pipelines trustworthy.

## 13. Reuse — no new observability/budget plumbing

`agent`/`agentParse` steps write `agent_run_stats` with a fixed-enum `stage`, so Grafana/Tempo dashboards, Temporal search attributes, and cost-per-PR panels light up unchanged. Brakes (`evaluate-brakes.ts`), `budget-exceeded` blocking, OTel spans (the workflow-side interceptor already active), and the `clarify`/`resume` escape hatches are reused. The interpreter's `InterpretedState` is queryable the same way `DevCycleState` is, so Mission Control's run-detail view (SP4) needs no new query surface.

## 14. Definition of done

- `AgentWorkflowDslSchema`, `ResolvedWorkflow`, `InterpretInputSchema`, `InterpretedState` in `contracts` with unit tests.
- `evalExpr` and `validateDsl` in `policies`, exhaustively unit-tested (invalid-DSL cases: unbounded `loop`/`forEach`, unknown activity/policy/parser, unresolvable path, unknown stage, unknown schemaVersion).
- `interpret` workflow + step library in `workflows`; `WorkflowSource` port + `BuiltinWorkflowSource` reading `packages/workflows/dsl/*.json`; `agent-workflow-routes.ts` `run` route in `control` — all with tests.
- `packages/workflows/dsl/devcycle.json` (§6) present and served by the built-in adapter.
- **Parity e2e:** the `devCycle` DSL, run through `interpret` on the `stub` backend, passes the same scenario the native `devCycle` e2e covers — all pre-implement stages, a **forced repair-loop iteration**, and a **tripped brake** — reaching the same terminal `InterpretedState` (`stage: done`/`status: done`, matching counters) as the native workflow on identical input.
- `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm e2e` green.
- ARCHITECTURE.md gains a DSL-interpreter section (git-first sourcing per §4.6; supersedes M8's git `RoleManifest`); AGENTS.md notes the interpreter as the sanctioned data-driven exception to rule #1 and clarifies the fixed-stage rule. Docs land in the same PR.

## 15. Open questions (carried into implementation or later sub-projects)

- **`branch` case-key grammar.** Booleans `truthy`/`falsy`; verdicts `pass`/`fail`/`unparseable`; statuses (`blocked`/`failed`/`done`); arbitrary enums by literal value. Settle the exact matching rule in the plan.
- **`startChild` result contract.** What terminal shape a child returns to a waiting parent (likely the child's `InterpretedState`, or a native workflow's own result) — pin in the plan; the cross-repo `targetRepo` case (ARCH §6.2) is SP3.
- **`self-heal.json` as a built-in in SP1?** `devCycle.json` is required for the parity gate. Shipping `self-heal.json` too is cheap and proves `agentParse`/`forEach`/`startChild` end-to-end — likely include it, decide in the plan.
- **When to deprecate native `devCycle`/`platform`.** Once parity holds and SP2 can source+trigger the DSL versions, are the hand-written workflows retired or kept as reference implementations? Deferred.
- **Prompt content outside code.** Refs suffice while reproducing `devCycle`/`platform` (prompts live in `packages/prompts`). A project-defined agent with a novel prompt needs its prompt body in the project repo alongside its DSL — revisit in SP3.
