// A task id can double as a git branch name (`agentops/<taskId>`) and a
// workspace directory name, so every part of it must be valid for both. A
// caller-supplied identifier -- an operator-chosen project name like "Artem
// private agents", or a Temporal-derived workflowId containing `:`/spaces --
// would otherwise produce something like `agentops/issue-Artem private
// agents-1` or `agentops/agent:Artem private agents:bughunt-...`, a branch
// name git rejects outright ("not a valid branch name") and a directory name
// with spaces. Lowercase, collapse every run of non-alphanumerics to a single
// dash, and trim leading/trailing dashes.
export function slugifyProject(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
