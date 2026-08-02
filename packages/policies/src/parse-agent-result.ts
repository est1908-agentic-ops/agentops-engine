export function parseAgentResult(output: string): unknown | undefined {
  const matches = [...output.matchAll(/^AGENT_RESULT:\s*(.+)$/gm)];
  const raw = matches.at(-1)?.[1];
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
