// A task id doubles as a git branch name (`agentops/<taskId>`) and a workspace
// directory name, so every part of it must be valid for both. The project name
// is operator-chosen free text -- e.g. "Artem private agents" -- which would
// otherwise produce `agentops/issue-Artem private agents-1`, a branch name git
// rejects outright ("not a valid branch name") and a directory name with spaces.
// Lowercase, collapse every run of non-alphanumerics to a single dash, and trim
// leading/trailing dashes. Project names are unique in the managed-project
// registry, so distinct projects still (almost always) slug to distinct ids.
export function slugifyProject(project: string): string {
  return project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
