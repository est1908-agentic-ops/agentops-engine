import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { ModelRef } from '@agentops/contracts';
import { findingFingerprint, parseFindings } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({ startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 5 } });
const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({ startToCloseTimeout: '45 minutes', heartbeatTimeout: '15s', retry: { maximumAttempts: 5 } });

const FALLBACK_MODEL: ModelRef = { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' };

export async function whiteboxBugHunt(input: { repo: string; focus?: string }): Promise<{ filed: number; deduped: number }> {
  const taskId = workflowInfo().workflowId;
  const workflowType = workflowInfo().workflowType;
  const { project, config } = await activities.resolveRepoConfig(input.repo);
  const ws = await activities.prepareWorkspace({ taskId, repo: input.repo });
  let filed = 0, deduped = 0;
  try {
    const model = config.routing.bughunt ?? FALLBACK_MODEL;
    const result = await agentActivities.runAgent({
      taskId, stage: 'bughunt', attempt: 1, callIndex: 1,
      backend: model.backend, model: model.model, effort: model.effort,
      promptRef: 'whitebox-bughunt.md',
      promptContext: { focus: input.focus ?? 'security & correctness across the whole codebase' },
      workspaceRef: ws.workspaceRef,
      limits: { maxTokens: config.brakes.maxTokens, timeoutMs: 1_800_000 },
    });
    await activities.recordRunStats({
      taskId, stage: 'bughunt', backend: model.backend, model: model.model,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, wallMs: result.wallMs, outcome: 'pass',
      promptHash: result.promptHash, promptSource: result.promptSource, project, workflowType,
    });
    for (const f of parseFindings(result.output)) {
      const res = await activities.createIssue({
        repo: input.repo, project, title: `[bughunt] ${f.title}`,
        body: `${f.detail}\n\n**Severity:** ${f.severity}\n**Location:** ${f.location}`,
        labels: ['bug', 'whitebox'], dedupeFingerprint: findingFingerprint(f),
      });
      if (res.deduped) deduped += 1; else filed += 1;
    }
  } finally {
    await activities.cleanupWorkspace(ws.workspaceRef, input.repo);
  }
  return { filed, deduped };
}
