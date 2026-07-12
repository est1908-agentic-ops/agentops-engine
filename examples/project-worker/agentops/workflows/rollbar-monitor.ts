import { proxyActivities } from '@temporalio/workflow';
import { engineActivities } from '@agentic-ops/engine-sdk/workflow'; // childDevCycle/ENGINE_QUEUE available for extension
import type { TaskInput } from '@agentops/contracts'; // eslint-disable-line @typescript-eslint/no-unused-vars


// Example Tier-2 continuous workflow (Rollbar monitor style).
// In real: poll external API using project-owned activity + secret, then delegate.

export interface RollbarMonitorInput {
  repo: string;
  project: string;
  // synthetic findings for the e2e
  findings?: Array<{ title: string; body: string; fingerprint: string }>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const _projectActivities = proxyActivities<{ rollbarFetch: (cursor: string) => Promise<any> }>({
  taskQueue: 'proj-acme', // would be the project's queue, but for demo the e2e registers the activity on project worker
  startToCloseTimeout: '1 minute',
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function rollbarMonitor(input: RollbarMonitorInput): Promise<{ filed: number }> {
  const eng = engineActivities();
  const findings = input.findings ?? [{ title: 'Example bug', body: 'From rollbar', fingerprint: 'fp-demo' }];
  let filed = 0;
  for (const f of findings) {
    // In real would call own project activity here.
    await eng.createIssue({
      repo: input.repo,
      project: input.project,
      title: f.title,
      body: f.body,
      labels: ['bug'],
      dedupeFingerprint: f.fingerprint,
    });
    filed++;
    // could childDevCycle for auto fix, but for e2e authz/delegation the createIssue suffices.
  }
  return { filed };
}
