import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { PlatformAgentInput, PlatformAgentResult, TaskInput } from '@agentops/contracts';
import { PlatformAgentResultSchema } from '@agentops/contracts';
import { parsePlatformResult } from '@agentops/policies';
import { devCycle } from './dev-cycle';
import type { PlatformActivities } from './platform-activities-api';

const activities = proxyActivities<PlatformActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

const agentActivities = proxyActivities<Pick<PlatformActivities, 'runAgent'>>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

// This role isn't scoped to one product, so there's no ProductConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. 'platform' (not 'pi') as the backend key: it's the pi CLI,
// but a distinct worker backend entry with this role's own ServiceAccount/secrets
// (see packages/worker/src/main.ts buildBackends).
const PLATFORM_MODEL = { backend: 'platform', model: 'zai/glm-5.2', effort: 'high' as const };
const PLATFORM_MAX_TOKENS = 400_000;
const PLATFORM_TIMEOUT_MS = 1_800_000;
const MAX_RESULT_CALLS = 2;

export async function platform(input: PlatformAgentInput): Promise<PlatformAgentResult> {
  const taskId = workflowInfo().workflowId;
  const { workspaceRef } = await activities.prepareScratchWorkspace(taskId);

  let payload;
  try {
    for (let call = 1; call <= MAX_RESULT_CALLS; call += 1) {
      const result = await agentActivities.runAgent({
        taskId,
        stage: 'platform',
        attempt: 1,
        callIndex: call,
        backend: PLATFORM_MODEL.backend,
        model: PLATFORM_MODEL.model,
        effort: PLATFORM_MODEL.effort,
        promptRef: 'platform.md',
        promptContext: {
          taskId,
          prompt: input.prompt,
          hintRepos: (input.hintRepos ?? []).join(', ') || '(none provided)',
        },
        workspaceRef,
        limits: { maxTokens: PLATFORM_MAX_TOKENS, timeoutMs: PLATFORM_TIMEOUT_MS },
      });
      await activities.recordRunStats({
        taskId,
        stage: 'platform',
        backend: PLATFORM_MODEL.backend,
        model: PLATFORM_MODEL.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        wallMs: result.wallMs,
        outcome: 'pass',
      });
      const parsed = parsePlatformResult(result.output);
      if (parsed.parseable) {
        payload = parsed.payload;
        break;
      }
    }
  } finally {
    await activities.cleanupScratchWorkspace(workspaceRef);
  }

  if (!payload) {
    return PlatformAgentResultSchema.parse({
      summary: `agent output was unparseable after ${MAX_RESULT_CALLS} attempt(s)`,
    });
  }

  const childWorkflows: PlatformAgentResult['childWorkflows'] = [];
  for (const [index, fix] of payload.proposedFixes.entries()) {
    const { product, config } = await activities.resolveRepoConfig(fix.repo);
    const childTaskId = `${taskId}-fix-${index + 1}`;
    const taskInput: TaskInput = { taskId: childTaskId, product, repo: fix.repo, goal: fix.goal, config };
    await executeChild(devCycle, { workflowId: childTaskId, args: [taskInput] });
    childWorkflows.push({ workflowId: childTaskId, repo: fix.repo, goal: fix.goal });
  }

  return PlatformAgentResultSchema.parse({
    summary: payload.summary,
    actionsTaken: payload.actionsTaken,
    childWorkflows,
  });
}
