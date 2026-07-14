# M5 — Multi-Backend & Budget Enforcement — Decomposition

Status: draft · 2026-07-07 · Owner: Artem
Milestone: M5 (see [MILESTONES.md](../../MILESTONES.md#m5--multi-backend--budget-enforcement), [ARCHITECTURE.md §5.5/§8.1](../../ARCHITECTURE.md))

## Context

M5's gate — "two repos run different stage/model routing; a deliberately low budget trips the brake with a clear reason" — reads as if it needs new orchestration code. It mostly doesn't: `packages/workflows/src/dev-cycle.ts` already reads `routing[stage]` per stage (`runStageAgent`) and `escalation` on the last-but-one repair attempt (`next-repair-action.ts`), and `evaluate-brakes.ts`'s `maxTokens` brake already trips on real per-call token usage accumulated from `claude`'s CLI output. `pi` already exists as a second CLI backend. None of that is new work.

What's actually missing is the *substance* the milestone name promises: **LiteLLM never has anything to enforce a budget on**, because both existing backends (`claude`, `pi`) are CLI subscription spawns that authenticate themselves and never touch LiteLLM — ARCHITECTURE.md §5.5's two lanes are real, and today only the subscription-CLI lane is built. `secrets/litellm/` in `agentops-platform` is an empty placeholder; no ArgoCD Application deploys it. Deciding here: **LiteLLM only earns its place in this milestone once a stage's traffic actually flows through it** — its virtual-key hard cap is the new, distinct enforcement mechanism the gate should demonstrate, not a redundant re-proof of the token brake that already works.

Per Artem's decisions this round: **cursor backend is deferred** (ToS on automation unverified per ARCHITECTURE.md §9/§10; not needed for the gate since `pi` already provides a second CLI backend) — explicit non-goal for this decomposition, not silently dropped. First real LiteLLM consumer targets **z.ai's API-key lane** (reuses a provider already paid for via the `claude` backend's `ANTHROPIC_BASE_URL` swap, now via its native API instead of the CLI).

Like M2/M4, this spans two repos and several fairly independent pieces — decomposed below, gate-first: sub-projects are ordered so the ones the actual done-when needs ship before the one that's independently useful but not gate-critical.

## Sub-projects

1. **Deploy LiteLLM** (`agentops-platform`) — ArgoCD Application + Helm values for the LiteLLM gateway; admin API reachable for virtual-key creation; SOPS secret structure for the z.ai API key (replacing the `secrets/litellm/.gitkeep` placeholder). No dependency on anything else. Verified by rendering (`helm template`), same as sub-project 1 of M4 — no live cluster access in this session, so actual in-cluster health is an operator follow-up, not claimed here.
2. **LiteLLM-routed API backend** (`agentops-engine`) — a new *non-CLI* backend kind: `packages/backends/src/litellm/`, an HTTP client against LiteLLM's OpenAI-compatible endpoint instead of a CLI spawn, targeting a z.ai model. Contracts change: `ModelRefSchema.backend` gains a `'litellm'` literal (a transport kind, same role `claude`/`pi`/`codex` already play — the model string itself carries the provider-qualified model name LiteLLM expects, e.g. `"zai/glm-4.6"`). Depends on (1) for the endpoint/auth *contract* (base URL shape, virtual-key header, budget-exceeded response shape) — not on (1) being live-deployed, same "build against the documented contract" pattern M4 sub-project 2 used against sub-project 1's OTLP endpoint.
3. **Demonstrate the gate end-to-end** (`agentops-engine`) — wires (2) into a second routing profile and proves both halves of the done-when in one e2e test (`TestWorkflowEnvironment`, mocked LiteLLM HTTP responses — no real spend): two `ProductConfig`s routing a stage to `claude` vs. `litellm`/z.ai, and a deliberately-low virtual-key cap on the LiteLLM side producing a **distinct, clear blocked reason** (not conflated with the existing `token-brake`). Depends on (2).
4. **Subscription rate-window awareness** (`agentops-engine`) — a scheduling gate limiting concurrent Job launches per subscription-lane backend (`claude`, `pi`) against a configured prompts-per-5h/week quota (ARCHITECTURE.md §5.5/§9). Entirely orthogonal to (1)-(3): this is the CLI/subscription lane, not the API/LiteLLM lane. No dependency on anything above; sequenced last only so the "budget enforcement" story finishes as one piece before this one starts.

Recommended build order: **1 → 2 → 3**, with **4** buildable any time after this doc (in parallel with 1-3 if a second implementer picks it up).

## Cross-cutting decisions (binding on all sub-projects below)

- **`backend: 'litellm'` is a transport kind, not a provider.** `ModelRef.model` stays the provider-qualified model string (mirrors how `claude`'s `model` field is already a bare model name and `pi`'s is too) — no new per-provider backend literals for every future LiteLLM-fronted provider (OpenRouter, direct Anthropic/OpenAI) get added later without a contracts change; z.ai is just the first model routed this way.
- **The existing `maxTokens` brake (workflow-level, in-memory `cumulativeTokens`) is not replaced.** LiteLLM's hard cap is an *additional*, independent enforcement layer per ARCHITECTURE.md §7 ("Enforce: `maxTokens` brake per task; LiteLLM hard caps per role key; monthly envelope per subscription") — the two can and will coexist, tripping for different reasons on different lanes.
- **A LiteLLM budget-exceeded response is a definitive, non-retryable failure**, not a transient one Temporal should retry. Follow the precedent already in this repo (`WorkspaceError.nonRetryable` → `ApplicationFailure.nonRetryable` in `packages/activities/src/create-activities.ts:20-25`, landed 2026-07-07): the litellm backend throws a typed error on a budget-exceeded response, `runAgent` converts it at the activity boundary, and the workflow maps it to a new `BlockReason` (leaning `'budget-exceeded'`, extending `packages/contracts/src/stage.ts`'s `BlockReasonSchema`) distinct from `'token-brake'`. Final call deferred to sub-project 3's own design.
- **"Two repos routing differently" is proven by e2e test, not by registering a second real product.** `agentops-platform`'s project registry has exactly one real entry (`acme`) today; provisioning a second live product is a config exercise once this ships, not additional code — same reasoning M0/M1 used (`stub` backend, fake issue → fake PR) to prove pipeline behavior without spending tokens or needing live infra.
- **`pi`'s `tokensIn`/`tokensOut` are hardcoded to `0`** (found during research for this decomposition — `packages/backends/src/pi/pi-backend.ts`) — a pre-existing gap unrelated to this milestone's gate, since the gate's two routing profiles are `claude` vs. `litellm`. Flagged, not fixed here; non-goal for this decomposition.
- **Repo/workspace note:** sub-project 1 lands in `agentops-platform`, not this repo — its own branch off `main` there, same isolation this repo uses per unit of work (per M2/M4 precedent).

## Definition of done

Sub-projects 1-3 landed: a `ProductConfig` can route a stage through `claude` or through the new `litellm`/z.ai backend; a deliberately-low LiteLLM virtual-key cap trips a distinct, clearly-reasoned blocked state, proven end-to-end without live spend. Sub-project 4 landed: concurrent subscription-lane Job launches respect a configured rate window. Cursor backend remains an explicit non-goal until its automation ToS is checked.

## Open questions carried forward

- **LiteLLM chart/version and admin-key management** (how the admin API key itself is provisioned/rotated via SOPS) — deferred to sub-project 1's own design.
- **Exact LiteLLM `config.yaml` model-alias mapping for z.ai** (LiteLLM needs a named model pointing at z.ai's endpoint + key) — deferred to sub-project 1/2's designs, whichever ends up owning the LiteLLM-side config file.
- **Real subscription quota numbers** (prompts per 5h/week for the Claude Max and z.ai GLM plans actually in use) — deferred to sub-project 4's design; will use documented placeholder defaults and flag them as assumptions unless real numbers are supplied.
- **New `BlockReason` value naming and exact propagation path** (activity-thrown typed error → `ApplicationFailure.nonRetryable` → workflow catch → `state.blockReason`) — leaning decision stated above under cross-cutting decisions; finalized in sub-project 3's design.
