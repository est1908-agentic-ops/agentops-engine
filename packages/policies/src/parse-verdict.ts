import type { VerdictKind } from '@agentops/contracts';

export interface ParsedVerdict {
  kind: VerdictKind;
  findings?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tolerates a short run of markdown decoration before the literal sentinel --
// bold/italic (**/__), bullets (-/*), blockquotes (>), and headings (#) are
// all things a model can wrap a "machine-parsed" line in without meaning to
// hide it. The prefix is capped at 6 chars and built only from decoration
// characters/whitespace, so it still can't match a sentinel buried after real
// words mid-line (e.g. "Summary: FULL: PASS") -- that's the same "never
// mid-line" guarantee the tests already pin, just with a wider definition of
// "start of line".
const SENTINEL_PREFIX = '[\\s>#*_-]{0,6}';

export function parseVerdict(text: string, sentinel: string): ParsedVerdict {
  const pattern = new RegExp(
    `^${SENTINEL_PREFIX}${escapeRegExp(sentinel)}\\s*(PASS|FAIL)\\b(.*)$`,
    'gm',
  );
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
  // Trailing decoration closing out the same wrapper the prefix tolerated
  // (e.g. the closing "**" of "**FULL: PASS**") is noise, not a finding.
  const findingsText = rest.trim().replace(/[\s*_]+$/, '');
  return findingsText.length > 0 ? { kind, findings: [findingsText] } : { kind };
}
