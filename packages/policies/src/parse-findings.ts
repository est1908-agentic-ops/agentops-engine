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
  try { json = JSON.parse(last[1]); } catch { return []; }
  if (!Array.isArray(json)) return [];
  const out: WhiteboxFinding[] = [];
  for (const item of json) {
    const res = WhiteboxFindingSchema.safeParse(item);
    if (res.success) out.push(res.data);
  }
  return out;
}

function normalizeLocation(location: string): string {
  // Strip trailing position suffixes (:line, :line:col, :startLine-endLine)
  // Only strip if the trailing segment(s) after the last colon are purely numeric or n-n format.
  // Non-numeric trailing segments are left intact (degrade to old behavior).
  return location.replace(/:\d+(?::\d+|-\d+)?$/, '');
}

export function findingFingerprint(f: WhiteboxFinding): string {
  const normalizedLocation = normalizeLocation(f.location);
  return sha256(`${normalizedLocation}::${f.title}`.toLowerCase().replace(/\s+/g, ' ').trim());
}
