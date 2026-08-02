export function parseAgentResult(output: string): unknown | undefined {
  const matches = [...output.matchAll(/^AGENT_RESULT:[ \t]*(.+?)[ \t]*\r?$/gm)];
  const lastMatch = matches.at(-1);
  if (!lastMatch || !/^[\r\n\t ]*$/.test(output.slice(lastMatch.index + lastMatch[0].length))) {
    return undefined;
  }
  try {
    return JSON.parse(lastMatch[1]);
  } catch {
    return undefined;
  }
}
