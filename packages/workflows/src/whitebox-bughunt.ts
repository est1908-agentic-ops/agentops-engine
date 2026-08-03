import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import { findingFingerprint, parseFindings, slugifyProject } from '@agentops/policies';
import { DEFAULT_TRIGGER_LABEL } from '@agentops/contracts';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});
const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

export async function whiteboxBugHunt(input: {
  repo: string;
  focus?: string;
}): Promise<{ filed: number; deduped: number }> {
  // workflowId is schedule-derived (`agent:<project>:<name>-workflow-<ts>`,
  // see scheduleId in @agentops/policies/reconcile-agents) and keeps the raw,
  // unslugified project name -- fine for Temporal, but taskId doubles as a git
  // branch (`agentops/<taskId>`) and workspace dir, so it must be slugified
  // the same way startDevCycleForIssue's taskId is. See est1908/agents
  // bughunt-test-workflow-2026-07-13T12:00:00Z: prepareWorkspace failed
  // ("not a valid branch name") because the raw workflowId contains `:` and
  // spaces from the project name "Artem private agents".
  const taskId = slugifyProject(workflowInfo().workflowId);
  const workflowType = workflowInfo().workflowType;
  const { project, config } = await activities.resolveRepoConfig(input.repo);
  const ws = await activities.prepareWorkspace({ taskId, repo: input.repo });
  let filed = 0,
    deduped = 0;
  try {
    const tier = config.routing.bughunt?.tier ?? 'bughunt';
    const effort = config.routing.bughunt?.effort;
    const result = await agentActivities.runAgent({
      taskId,
      stage: 'bughunt',
      attempt: 1,
      callIndex: 1,
      tier,
      effort,
      projectTiers: config.tiers,
      promptRef: 'whitebox-bughunt.md',
      promptContext: { focus: input.focus ?? 'security & correctness across the whole codebase' },
      workspaceRef: ws.workspaceRef,
      limits: { maxTokens: config.brakes.maxTokens, timeoutMs: 1_800_000 },
    });
    await activities.recordRunStats({
      taskId,
      stage: 'bughunt',
      backend: result.resolvedBackend ?? 'unknown',
      model: result.resolvedModel ?? 'unknown',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      wallMs: result.wallMs,
      outcome: 'pass',
      promptHash: result.promptHash,
      promptSource: result.promptSource,
      project,
      workflowType,
    });
    for (const f of parseFindings(result.output)) {
      const res = await activities.createIssue({
        repo: input.repo,
        project,
        title: `[bughunt] ${f.title}`,
        body: `${f.detail}\n\n**Severity:** ${f.severity}\n**Location:** ${f.location}`,
        labels: [DEFAULT_TRIGGER_LABEL, 'bug', 'whitebox'],
        dedupeFingerprint: findingFingerprint(f),
      });
      if (res.deduped) deduped += 1;
      else filed += 1;
    }
  } finally {
    await activities.cleanupWorkspace(ws.workspaceRef, input.repo);
  }
  return { filed, deduped };
}
