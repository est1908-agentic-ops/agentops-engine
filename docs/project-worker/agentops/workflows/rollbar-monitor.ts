import { continueAsNew, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';
import { childDevCycle, engineActivities } from '@agentic-ops/engine-sdk/workflow';
import type { RollbarFetchResult, RollbarItem } from '../activities/rollbar-fetch';

export interface RollbarMonitorInput {
  repo: string;
  project: string;
  autoFix?: boolean;
  /** Inject synthetic findings in tests without calling Rollbar. */
  findings?: RollbarItem[];
}

export interface RollbarMonitorCarry {
  cursor: string;
  filed: number;
}

const projectActivities = proxyActivities<{
  rollbarFetch(cursor: string): Promise<RollbarFetchResult>;
}>({
  startToCloseTimeout: '2 minutes',
});

const POLL_INTERVAL_MS = 60_000;
const CONTINUE_AS_NEW_AFTER = 100;

export async function rollbarMonitor(
  input: RollbarMonitorInput,
  carry?: RollbarMonitorCarry,
): Promise<{ filed: number }> {
  const eng = engineActivities();
  let cursor = carry?.cursor ?? '';
  let filed = carry?.filed ?? 0;
  let polls = 0;

  while (true) {
    polls += 1;

    let batch: RollbarItem[];
    if (input.findings?.length) {
      batch = input.findings;
    } else {
      const fetched = await projectActivities.rollbarFetch(cursor);
      cursor = fetched.nextCursor;
      batch = fetched.items;
    }

    for (const item of batch) {
      await eng.createIssue({
        repo: input.repo,
        project: input.project,
        title: item.title,
        body: item.body,
        labels: ['bug'],
        dedupeFingerprint: item.fingerprint,
      });
      filed += 1;

      if (input.autoFix) {
        await childDevCycle({
          taskId: `${workflowInfo().workflowId}-fix-${item.id}`,
          project: input.project,
          repo: input.repo,
          goal: `Fix Rollbar item: ${item.title}`,
        });
      }
    }

    if (polls >= CONTINUE_AS_NEW_AFTER) {
      await continueAsNew<typeof rollbarMonitor>(input, { cursor, filed });
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
