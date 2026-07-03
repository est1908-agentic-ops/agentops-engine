export interface ParsedRef {
  owner: string;
  repo: string;
  number: number;
}

export function parseRef(ref: string): ParsedRef {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!match) {
    throw new Error(`parseRef: expected "owner/repo#number", got "${ref}"`);
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export interface ParsedRepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(repo: string): ParsedRepoSlug {
  const match = /^([^/]+)\/([^/#]+)$/.exec(repo);
  if (!match) {
    throw new Error(`parseRepoSlug: expected "owner/repo", got "${repo}"`);
  }
  return { owner: match[1], repo: match[2] };
}
