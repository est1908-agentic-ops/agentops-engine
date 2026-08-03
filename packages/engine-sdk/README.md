# @agentic-ops/engine-sdk

Thin, secret-free facade for Tier-2 project workflows. It exposes engine
activities, including reusable read-only repository sessions and
`parseAgentResult` for the `AGENT_RESULT:` sentinel emitted by `generic-task.md`.

Repository sessions and `generic-task.md` are deliberately non-publishing: they
do not grant an agent a publishing capability or a GitHub credential. Never put
a GitHub token in an agent prompt, prompt context, or project-worker environment.
The SDK separately exposes privileged, explicit workflow activities (such as
issue/comment operations); those are not capabilities granted to an agent job by
a repository session. See
[`docs/authoring-project-workflows.md`](../../docs/authoring-project-workflows.md)
for the complete multi-repository lifecycle and authorization model.
