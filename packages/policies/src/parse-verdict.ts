import type { VerdictKind } from '@agentops/contracts';

export interface ParsedVerdict {
  kind: VerdictKind;
  findings?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseVerdict(text: string, sentinel: string): ParsedVerdict {
  const pattern = new RegExp(`^${escapeRegExp(sentinel)}\\s*(PASS|FAIL)\\b(.*)$`, 'gm');
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return { kind: 'unparseable' };
  }

  const [, verdictWord, rest] = lastMatch;
  const kind: VerdictKind = verdictWord === 'PASS' ? 'pass' : 'fail';
  const findingsText = rest.trim();
  return findingsText.length > 0 ? { kind, findings: [findingsText] } : { kind };
}
