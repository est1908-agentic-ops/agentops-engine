import type { TrackerPort } from '../tracker-port';
import { LinearGraphqlClient } from './linear-client';
import { LinearTrackerPort } from './linear-tracker-port';

export function createLinearTracker(token: string, fetchImpl?: typeof fetch): TrackerPort {
  return new LinearTrackerPort(new LinearGraphqlClient(token, fetchImpl));
}
