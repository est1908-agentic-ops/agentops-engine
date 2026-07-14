# @agentops/prompts

Versioned prompt packs for every workflow stage — the templates in
[`templates/`](templates/) (`design`, `plan`, `implement`, `review`,
`platform`, `whitebox-bughunt`, …) are the only place prompts live; never
inline strings in code (see AGENTS.md).

Each rendered prompt is hashed (`promptHash`) and its source recorded
(`promptSource`) on `agent_run_stats` and OTel spans for provenance.
