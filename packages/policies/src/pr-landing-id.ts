export function prLandingWorkflowId(prRef: string): string {
  const normalized = prRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `pr-landing-${normalized}`;
}
