import { parseRef } from './github/parse-ref';

export type ParsedTrackerRef = { kind: 'github'; repo: string } | { kind: 'linear'; teamKey: string; identifier: string };

const LINEAR_REF_PREFIX = 'linear:';

// Routes a TrackerPort ref to the project that owns it. GitHub refs
// ("owner/repo#N") always contain "/" and "#"; Linear identifiers
// ("ENG-123") never do -- so a "linear:" prefix is enough to disambiguate
// without any other lookup. Linear team keys are plain uppercase
// alphanumeric with no hyphen of their own, so splitting the identifier on
// its first "-" reliably recovers the team key.
export function parseTrackerRef(ref: string): ParsedTrackerRef {
  if (ref.startsWith(LINEAR_REF_PREFIX)) {
    const identifier = ref.slice(LINEAR_REF_PREFIX.length);
    const separatorIndex = identifier.indexOf('-');
    if (separatorIndex <= 0) {
      throw new Error(`parseTrackerRef: expected "linear:TEAMKEY-number", got "${ref}"`);
    }
    return { kind: 'linear', teamKey: identifier.slice(0, separatorIndex), identifier };
  }
  const { owner, repo } = parseRef(ref);
  return { kind: 'github', repo: `${owner}/${repo}` };
}

export function linearRef(identifier: string): string {
  return `${LINEAR_REF_PREFIX}${identifier}`;
}
