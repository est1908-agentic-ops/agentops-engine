import { PlatformSentinelSchema, type PlatformSentinelPayload } from '@agentops/contracts';

export interface ParsedPlatformResult {
  parseable: boolean;
  payload: PlatformSentinelPayload;
}

const EMPTY_PAYLOAD: PlatformSentinelPayload = { summary: '', actionsTaken: [], proposedFixes: [] };

export function parsePlatformResult(text: string): ParsedPlatformResult {
  // Constructed fresh per call (not module-scoped) -- a `g`-flagged RegExp is
  // stateful across exec() calls via lastIndex, and reusing one across
  // invocations would silently skip matches on some calls. Same reasoning as
  // parse-verdict.ts's per-call `new RegExp(...)`.
  const pattern = /^PLATFORM_RESULT:\s*(.+)$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { parseable: false, payload: EMPTY_PAYLOAD };
  }

  try {
    const json: unknown = JSON.parse(lastMatch[1]);
    return { parseable: true, payload: PlatformSentinelSchema.parse(json) };
  } catch {
    return { parseable: false, payload: EMPTY_PAYLOAD };
  }
}
