import { WhiteboxFindingSchema, sha256, type WhiteboxFinding } from '@agentops/contracts';

// Fail-safe like parse-platform-result: last `FINDINGS:` line wins, JSON parsed,
// each element validated; anything unparseable yields [] (never throws, never
// a silent bad file). Per-call RegExp (g-flag is stateful).
export function parseFindings(output: string): WhiteboxFinding[] {
  const re = /^FINDINGS:\s*(.+)$/gm;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(output); m !== null; m = re.exec(output)) last = m;
  if (!last) return [];
  let json: unknown;
  try {
    json = JSON.parse(last[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const out: WhiteboxFinding[] = [];
  for (const item of json) {
    const res = WhiteboxFindingSchema.safeParse(item);
    if (res.success) out.push(res.data);
  }
  return out;
}

export function findingFingerprint(f: WhiteboxFinding): string {
  return sha256(`${f.location}::${f.title}`.toLowerCase().replace(/\s+/g, ' ').trim());
}
