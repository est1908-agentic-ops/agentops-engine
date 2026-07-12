// Temporal header carrying the caller workflow's project identity into
// activities and child workflows. The reconciler/Schedule/trigger stamp
// `project` in the workflow memo (the trusted origin); the workflow-outbound
// interceptor copies it here so the engine's activity worker can validate
// repo-ownership without the memo (ActivityInfo does not carry memo). See
// SP2 design §7.2.
export const PROJECT_HEADER_KEY = 'x-agentops-project';

export function readProjectFromMemo(memo: Record<string, unknown> | undefined): string | undefined {
  const p = memo?.project;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}
