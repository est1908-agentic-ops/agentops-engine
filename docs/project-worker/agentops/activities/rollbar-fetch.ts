export interface RollbarItem {
  id: string;
  title: string;
  body: string;
  fingerprint: string;
}

export interface RollbarFetchResult {
  items: RollbarItem[];
  nextCursor: string;
}

/**
 * Project-owned activity: holds the Rollbar token (from externalSecrets).
 * Replace the stub with a real Rollbar API call filtered by `cursor`.
 */
export async function rollbarFetch(cursor: string): Promise<RollbarFetchResult> {
  const token = process.env.ROLLBAR_ACCESS_TOKEN;
  if (!token) {
    throw new Error('ROLLBAR_ACCESS_TOKEN is not set on the worker pod');
  }

  // Stub: no network in the reference. In production, page Rollbar since `cursor`,
  // map rows to RollbarItem[], and return the new high-water cursor.
  void token;
  void cursor;
  return { items: [], nextCursor: cursor };
}
