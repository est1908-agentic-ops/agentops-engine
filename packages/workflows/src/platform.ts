import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { PlatformAgentInput, PlatformAgentResult, TaskInput } from '@agentops/contracts';
import { DEFAULT_IDLE_TIMEOUT_MS, PlatformAgentResultSchema } from '@agentops/contracts';
import { parsePlatformResult } from '@agentops/policies';
import { devCycle } from './dev-cycle';
import type { PlatformActivities } from './platform-activities-api';

const activities = proxyActivities<PlatformActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

const agentActivities = proxyActivities<Pick<PlatformActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

// This role isn't scoped to one project, so there's no ProjectConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. 'platform' (not 'claude') as the backend key: it's the same
// claude CLI/model/credential (see packages/worker/src/main.ts buildBackends),
// but a distinct worker backend entry carrying this role's own
// ServiceAccount/secrets/pod-label -- keep routing through this key rather
// than switching to 'claude' directly, or the role silently loses cluster
// access again (see docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md).
const PLATFORM_MODEL = { backend: 'platform', model: 'claude-sonnet-5', effort: 'high' as const };
const PLATFORM_MAX_TOKENS = 400_000;
const PLATFORM_TIMEOUT_MS = 1_800_000;
const PLATFORM_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
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
        limits: { maxTokens: PLATFORM_MAX_TOKENS, idleTimeoutMs: PLATFORM_IDLE_TIMEOUT_MS, timeoutMs: PLATFORM_TIMEOUT_MS },
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
  const skippedFixes: PlatformAgentResult['skippedFixes'] = [];
  for (const [index, fix] of payload.proposedFixes.entries()) {
    const resolved = await activities.resolveRepoConfig(fix.repo);
    if (!resolved.registered) {
      // The agent is allowed to propose fixes for any repo, including its own
      // (see platform.md), but resolveRepoConfig has no SCM credentials for a
      // repo outside the project registry. Report it instead of crashing the
      // whole run over one unactionable suggestion.
      skippedFixes.push({ ...fix, reason: `no project registered for repo "${fix.repo}"` });
      continue;
    }
    const childTaskId = `${taskId}-fix-${index + 1}`;
    const taskInput: TaskInput = {
      taskId: childTaskId,
      project: resolved.project,
      repo: fix.repo,
      goal: fix.goal,
      config: resolved.config,
    };
    await executeChild(devCycle, { workflowId: childTaskId, args: [taskInput] });
    childWorkflows.push({ workflowId: childTaskId, repo: fix.repo, goal: fix.goal });
  }

  return PlatformAgentResultSchema.parse({
    summary: payload.summary,
    actionsTaken: payload.actionsTaken,
    childWorkflows,
    skippedFixes,
  });
}
