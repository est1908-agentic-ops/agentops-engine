# @agentic-ops/engine-sdk

Thin, secret-free facade for Tier-2 project workflows. It exposes engine
activities, including reusable read-only repository sessions and
`parseAgentResult` for the `AGENT_RESULT:` sentinel emitted by `generic-task.md`.

Repository sessions are deliberately non-publishing: the SDK has no push, PR,
issue, comment, or credential API for an agent. Never put a GitHub token in an
agent prompt, prompt context, or project-worker environment. See
[`docs/authoring-project-workflows.md`](../../docs/authoring-project-workflows.md)
for the complete multi-repository lifecycle and authorization model.
