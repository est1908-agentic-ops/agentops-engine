import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { DevCyclePrRepairInput, ProjectConfig } from '@agentops/contracts';
import { babysitDecision, nextRepairAction, parseVerdict } from '@agentops/policies';
import { feedbackHash } from '@agentops/contracts';
import type { DevCycleActivities } from './activities-api';

// Reuse the same activity proxies and constants as dev-cycle for determinism.
const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

const stopSignal = defineSignal('stop');
const cancelSignal = defineSignal('cancel');
const resumeSignal = defineSignal('resume');
const stateQuery = defineQuery<unknown>('state'); // reuse/extend DevCycleState shape in real impl

const DEFAULT_BABYSIT_POLL_MS = 5000;
const MAX_BABYSIT_WAITS = 240; // ~20min

class RepairCancelledError extends Error {}

function isBudgetExceededFailure(err: unknown): boolean {
  return (
    err instanceof ActivityFailure &&
    err.cause instanceof ApplicationFailure &&
    err.cause.type === 'LiteLlmBudgetExceededError'
  );
}

export async function devCyclePrRepair(input: DevCyclePrRepairInput): Promise<unknown> {
  const state: any = {
    taskId: input.taskId,
    stage: 'pr',
    status: 'running',
    blockReason: null,
    prRef: input.prRef,
    workspaceRef: '',
    branch: '',
    babysitRounds: 0,
    implementAttempts: 0,
    iterations: 0,
    cumulativeTokens: 0,
  };

  let cancelled = false;
  let _stopRequested = false;
  let effectiveBrakes: Record<string, unknown> = { maxBabysitRounds: 10, maxIterations: 20 }; // defaults; override with config

  setHandler(stopSignal, () => { _stopRequested = true; });
  setHandler(cancelSignal, () => { cancelled = true; });
  setHandler(resumeSignal, () => {
    state.status = 'running';
    state.blockReason = null;
  });
  setHandler(stateQuery, () => state);

  // Resolve config if needed (same pattern as devCycle)
  let config: ProjectConfig | undefined = input.config;
  if (!config) {
    const resolved = await activities.resolveRepoConfig(input.repo);
    config = resolved.config;
  }
  if (config?.brakes) {
    effectiveBrakes = { ...effectiveBrakes, ...config.brakes };
  }

  const waitForResumeOrCancel = async (): Promise<boolean> => {
    await condition(() => cancelled || state.status === 'running');
    return cancelled;
  };

  const runStageAgent = async (stage: 'implement' | 'full_verify' | 'review', attempt: number, extraContext: Record<string, unknown> = {}) => {
    // Simplified — in full impl use the exact routing + budget handling from dev-cycle
    let result;
    while (true) {
      try {
        result = await agentActivities.runAgent({
          taskId: input.taskId,
          stage,
          attempt,
          callIndex: 1,
          tier: 'smart',
          projectTiers: config?.tiers ?? {},
          image: config?.image,
          services: config?.services ?? [],
          promptRef: `${stage}.md`,
          promptContext: { taskId: input.taskId, goal: 'Address PR review comments', prReviewFeedback: input.prReviewFeedback ?? '', ...extraContext },
          workspaceRef: state.workspaceRef,
          limits: { maxTokens: effectiveBrakes.maxTokens ?? 100000 },
        });
        break;
      } catch (err) {
        if (!isBudgetExceededFailure(err)) throw err;
        state.status = 'blocked';
        state.blockReason = 'budget-exceeded';
        if (await waitForResumeOrCancel()) throw new RepairCancelledError();
      }
    }
    state.cumulativeTokens += (result.tokensIn || 0) + (result.tokensOut || 0);
    return result.output;
  };

  try {
    // Prepare workspace on the PR's head branch
    const prepared = await activities.prepareWorkspace({
      taskId: input.taskId,
      repo: input.repo,
      initCommands: config?.initCommands ?? [],
      headBranch: input.headBranch,
    });
    state.workspaceRef = prepared.workspaceRef;
    state.branch = prepared.branch || input.prRef; // fallback

    // Full repair loop (implement + verify + review)
    let implementAttempt = 1;
    let lastFullVerify = '';
    let lastReview = '';

    while (true) {
      state.stage = 'implement';
      const implOut = await runStageAgent('implement', implementAttempt, {
        fullVerifyFindings: lastFullVerify,
        reviewFindings: lastReview,
      });
      state.implementAttempts = implementAttempt;
      state.iterations += 1;

      state.stage = 'full_verify';
      const fullVerifyOutput = await runStageAgent('full_verify', implementAttempt);
      const fvParsed = parseVerdict(fullVerifyOutput, 'FULL:');
      lastFullVerify = fullVerifyOutput;

      if (fvParsed.kind === 'pass') {
        state.stage = 'review';
        const reviewOutput = await runStageAgent('review', implementAttempt);
        const rvParsed = parseVerdict(reviewOutput, 'VERDICT:');
        lastReview = reviewOutput;
      }

      const fullVerifyKind = fvParsed.kind === 'pass' ? 'pass' : 'fail';
      const reviewKind = (typeof lastReview !== 'undefined' && parseVerdict(lastReview, 'VERDICT:').kind === 'pass') ? 'pass' : 'fail';
      const action = nextRepairAction({
        implementAttempts: implementAttempt,
        iterations: state.iterations as number,
        cumulativeTokens: state.cumulativeTokens as number,
        fullVerify: fullVerifyKind,
        review: reviewKind,
        diffEmpty: implOut ? implOut.trim().length === 0 : false,
        brakes: {
          maxImplementAttempts: 5,
          maxIterations: 20,
          maxTokens: 100000,
          maxBabysitRounds: 10,
          ...(effectiveBrakes as any),
        },
        hasEscalationModel: false,
      });

      if (action.kind === 'continue' || action.kind === 'open-pr-exhausted') break;
      implementAttempt += 1;
    }

    // Push the changes
    await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-repair-${implementAttempt}`);

    // Full babysit (identical to devCycle)
    const seen = new Set<string>();
    let waiting = 0;
    state.stage = 'pr_babysit';

    while (true) {
      await sleep(DEFAULT_BABYSIT_POLL_MS);
      const feedback = await activities.getPrFeedback(input.prRef);
      const decision = babysitDecision(feedback, seen, state.babysitRounds, effectiveBrakes.maxBabysitRounds ?? 10, waiting, MAX_BABYSIT_WAITS);

      if (decision === 'merge_ready') break;

      if (decision === 'actionable') {
        waiting = 0;
        seen.add(feedbackHash(feedback));
        state.babysitRounds += 1;
        implementAttempt += 1;
        state.stage = 'implement';
        const reviewComments = (feedback as any).comments
          ?.filter((c: any) => !c.resolved)
          .map((c: any) => c.body)
          .join('\n\n---\n\n') || '';
        await runStageAgent('implement', implementAttempt, {
          fullVerifyFindings: lastFullVerify,
          reviewFindings: lastReview,
          prReviewFeedback: reviewComments,
        });
        await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-repair-${implementAttempt}`);
        state.stage = 'pr_babysit';
        continue;
      }

      waiting += 1;
      if (waiting >= MAX_BABYSIT_WAITS) {
        state.status = 'blocked';
        state.blockReason = 'babysit-brake';
        await waitForResumeOrCancel();
        waiting = 0;
      }
    }

    state.stage = 'done';
    state.status = 'done';
    await activities.cleanupWorkspace(state.workspaceRef as string, input.repo);
    return state;

  } catch (err) {
    if (!(err instanceof RepairCancelledError)) throw err;
    state.stage = 'failed';
    state.status = 'failed';
    await activities.cleanupWorkspace(state.workspaceRef as string, input.repo);
    return state;
  }
}
