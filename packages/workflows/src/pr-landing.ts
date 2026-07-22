import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  Brakes,
  PrLandingInput,
  PrLandingState,
  PrSnapshot,
  ProjectConfig,
} from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import {
  babysitDecision,
  decideMergeAuthority,
  nextRepairAction,
  parseVerdict,
  resolveStageLimits,
} from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

export const prLandingWakeSignal = defineSignal('wake');
export const prLandingCancelSignal = defineSignal('cancel');
export const prLandingResumeSignal = defineSignal('resume');
export const prLandingStateQuery = defineQuery<PrLandingState>('state');

const DEFAULT_BABYSIT_POLL_MS = 5000;
const MAX_BABYSIT_WAIT_MS = 20 * 60_000;
const MAX_BABYSIT_WAITS = Math.ceil(MAX_BABYSIT_WAIT_MS / DEFAULT_BABYSIT_POLL_MS);
// A `pending` CI check is genuinely still running, so it gets a much larger
// budget than stale feedback -- long enough to outlast a slow CI *queue*
// (devcycle-109 hung when queue latency ~52min blew past the 20min cap) before
// braking for a human. `unreadable` still brakes immediately (babysit-decision).
const MAX_PENDING_CI_WAIT_MS = 4 * 60 * 60_000;
const MAX_PENDING_CI_WAITS = Math.ceil(MAX_PENDING_CI_WAIT_MS / DEFAULT_BABYSIT_POLL_MS);

class PrLandingCancelledError extends Error {}

function isBudgetExceededFailure(err: unknown): boolean {
  return (
    err instanceof ActivityFailure &&
    err.cause instanceof ApplicationFailure &&
    err.cause.type === 'LiteLlmBudgetExceededError'
  );
}

export async function prLanding(input: PrLandingInput): Promise<PrLandingState> {
  let config: ProjectConfig;
  if (input.config) {
    config = input.config;
  } else {
    const resolved = await activities.resolveRepoConfig(input.repo);
    config = resolved.config;
  }

  const state: PrLandingState = {
    taskId: input.taskId,
    project: input.project,
    repo: input.repo,
    phase: 'validating',
    outcome: null,
    blockReason: null,
    prRef: input.prRef,
    agentCreated: input.agentCreated,
    autoMergeMode: config.autoMerge ?? 'disabled',
    mergeResult: null,
    workspaceRef: '',
    branch: '',
    currentHeadSha: null,
    validatedHeadSha: null,
    implementAttempts: 0,
    iterations: 0,
    cumulativeTokens: 0,
    babysitRounds: 0,
  };

  let cancelled = false;
  let woke = false;
  let effectiveBrakes: Brakes = { ...config.brakes };

  setHandler(prLandingCancelSignal, () => {
    cancelled = true;
  });
  setHandler(prLandingWakeSignal, () => {
    woke = true;
  });
  setHandler(prLandingResumeSignal, () => {
    if (state.blockReason === 'repair-brake') {
      effectiveBrakes = {
        ...effectiveBrakes,
        maxImplementAttempts: Number.MAX_SAFE_INTEGER,
        maxIterations: Number.MAX_SAFE_INTEGER,
        maxTokens: Number.MAX_SAFE_INTEGER,
      };
    }
    if (state.blockReason === 'babysit-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxBabysitRounds: Number.MAX_SAFE_INTEGER };
    }
    state.blockReason = null;
    state.phase = state.validatedHeadSha ? 'babysitting' : 'validating';
  });
  setHandler(prLandingStateQuery, () => state);

  const waitAtBrake = async (
    reason: 'repair-brake' | 'babysit-brake',
  ): Promise<'resume' | 'cancelled'> => {
    state.phase = 'blocked';
    state.blockReason = reason;
    await condition(() => cancelled || state.blockReason === null);
    if (cancelled) {
      state.phase = 'done';
      state.outcome = 'cancelled';
      return 'cancelled';
    }
    return 'resume';
  };

  const waitForResumeOrCancel = async (): Promise<boolean> => {
    await condition(() => cancelled || state.blockReason === null);
    return cancelled;
  };

  async function runStageAgent(
    stage: 'implement' | 'full_verify' | 'review',
    attempt: number,
    promptContext: Record<string, unknown> = {},
  ): Promise<string> {
    const route = config.routing[stage];
    const limits = { maxTokens: config.brakes.maxTokens, ...resolveStageLimits(config, stage) };
    let result;
    while (true) {
      if (cancelled) throw new PrLandingCancelledError();
      try {
        result = await agentActivities.runAgent({
          taskId: input.taskId,
          stage,
          attempt,
          callIndex: 1,
          tier:
            route?.tier ??
            (stage === 'implement' ? 'implementation' : stage === 'review' ? 'review' : 'smart'),
          effort: route?.effort,
          projectTiers: config.tiers,
          image: config.image,
          services: config.services ?? [],
          promptRef: `${stage}.md`,
          promptContext: { taskId: input.taskId, goal: `Land ${input.prRef}`, ...promptContext },
          workspaceRef: state.workspaceRef,
          limits,
        });
        break;
      } catch (err) {
        if (!isBudgetExceededFailure(err)) throw err;
        state.phase = 'blocked';
        state.blockReason = 'repair-brake';
        if (await waitForResumeOrCancel()) throw new PrLandingCancelledError();
      }
    }
    state.cumulativeTokens += result.tokensIn + result.tokensOut;
    await activities.recordRunStats({
      taskId: input.taskId,
      stage,
      backend: result.resolvedBackend ?? 'unknown',
      model: result.resolvedModel ?? 'unknown',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      wallMs: result.wallMs,
      outcome: 'pass',
      promptHash: result.promptHash,
      promptSource: result.promptSource,
      project: input.project,
      workflowType: 'prLanding',
    });
    await activities.recordStageResult({
      taskId: input.taskId,
      stage,
      source: 'agent',
      contentHash: `${stage}-${attempt}-1`,
      tokens: result.tokensIn + result.tokensOut,
      outcome: 'pass',
    });
    return result.output;
  }

  async function validateHead(
    initial: PrSnapshot,
    reviewFeedback = '',
  ): Promise<'pass' | 'blocked'> {
    let snapshot = initial;
    let feedback = reviewFeedback;
    while (true) {
      if (cancelled) throw new PrLandingCancelledError();
      state.phase = 'validating';
      state.currentHeadSha = snapshot.headSha;
      const fullOutput = await runStageAgent('full_verify', state.implementAttempts + 1, {
        verifyCommands: [
          ...(config.fastVerifyCommands ?? []),
          ...(config.fullVerifyCommands ?? []),
        ].join('\n'),
      });
      const fullVerdict = parseVerdict(fullOutput, 'FULL:');
      let reviewVerdict: 'pass' | 'fail' = 'fail';
      let reviewOutput = '';
      if (fullVerdict.kind === 'pass') {
        reviewOutput = await runStageAgent('review', state.implementAttempts + 1);
        reviewVerdict = parseVerdict(reviewOutput, 'VERDICT:').kind === 'pass' ? 'pass' : 'fail';
      }
      if (fullVerdict.kind === 'pass' && reviewVerdict === 'pass') {
        state.validatedHeadSha = snapshot.headSha;
        return 'pass';
      }

      const action = nextRepairAction({
        implementAttempts: state.implementAttempts,
        iterations: state.iterations,
        cumulativeTokens: state.cumulativeTokens,
        fullVerify: fullVerdict.kind === 'pass' ? 'pass' : 'fail',
        review: reviewVerdict,
        diffEmpty: false,
        brakes: effectiveBrakes,
        hasEscalationModel: Boolean(config.escalation),
      });
      if (action.kind === 'block' || action.kind === 'open-pr-exhausted') {
        state.blockReason = 'repair-brake';
        return 'blocked';
      }

      if (snapshot.headRepo.toLowerCase() !== input.repo.toLowerCase()) {
        state.blockReason = 'provider-refused';
        return 'blocked';
      }

      state.phase = 'repairing';
      state.implementAttempts += 1;
      state.iterations += 1;
      // implement.md requires fullVerifyFindings + reviewFindings + prReviewFeedback;
      // omitting any makes renderPrompt throw (the PR #155 self-heal crash). Give
      // the current round's verify/review output their own slots and carry the
      // accumulated human/review feedback in prReviewFeedback.
      await runStageAgent('implement', state.implementAttempts, {
        fullVerifyFindings: fullOutput,
        reviewFindings: reviewOutput,
        prReviewFeedback: feedback,
      });
      feedback = [feedback, fullOutput, reviewOutput].filter(Boolean).join('\n\n---\n\n');
      await activities.pushBranch(
        input.repo,
        state.workspaceRef,
        state.branch,
        `${input.taskId}-${state.implementAttempts}`,
      );
      snapshot = await activities.getPrSnapshot(input.prRef);
    }
  }

  async function babysitAndMerge(): Promise<PrLandingState> {
    const seen = new Set<string>();
    let waiting = 0;
    let maxBabysitWaits = MAX_BABYSIT_WAITS;
    // Gate the larger pending budget behind a patch so this change is
    // replay-safe: an in-flight workflow already parked at a babysit-brake has
    // no marker in its history, so `patched()` returns false on replay and it
    // keeps the original short budget -- braking exactly where its history
    // recorded, and resuming without a non-determinism error. Only executions
    // started after this deploys get the longer pending budget.
    let maxPendingWaits = patched('pr-landing-pending-budget-v1')
      ? MAX_PENDING_CI_WAITS
      : MAX_BABYSIT_WAITS;

    while (true) {
      woke = false;
      state.phase = 'babysitting';
      await condition(() => woke || cancelled, DEFAULT_BABYSIT_POLL_MS);
      if (cancelled) throw new PrLandingCancelledError();
      const snapshot = await activities.getPrSnapshot(input.prRef);
      state.currentHeadSha = snapshot.headSha;

      const feedback = {
        ciStatus: snapshot.ciStatus,
        unresolvedThreads: snapshot.unresolvedThreads,
        comments: snapshot.comments,
      };
      const decision = babysitDecision(
        feedback,
        seen,
        state.babysitRounds,
        effectiveBrakes.maxBabysitRounds,
        waiting,
        maxBabysitWaits,
        maxPendingWaits,
      );

      if (decision === 'merge_ready') {
        const fresh = await activities.getPrSnapshot(input.prRef);
        state.currentHeadSha = fresh.headSha;
        if (fresh.state === 'merged') {
          state.phase = 'done';
          state.outcome = 'merged';
          return state;
        }
        if (fresh.state !== 'open' || fresh.draft || fresh.headSha !== state.validatedHeadSha) {
          state.validatedHeadSha = null;
          if ((await validateHead(fresh)) === 'blocked') {
            if (state.blockReason === 'provider-refused') {
              state.phase = 'blocked';
              state.outcome = 'blocked';
              return state;
            }
            if ((await waitAtBrake('repair-brake')) === 'cancelled') return state;
          }
          continue;
        }

        if (
          decideMergeAuthority({
            mode: config.autoMerge ?? 'disabled',
            agentCreated: input.agentCreated,
            labels: fresh.labels,
          }) === 'manual'
        ) {
          state.phase = 'done';
          state.outcome = 'merge-ready-manual';
          return state;
        }

        state.phase = 'merging';
        const merge = await activities.mergePr({
          prRef: input.prRef,
          expectedHeadSha: fresh.headSha,
        });
        state.mergeResult = merge;
        if (merge.kind === 'merged' || merge.kind === 'already-merged') {
          state.phase = 'done';
          state.outcome = 'merged';
          return state;
        }
        if (merge.kind === 'head-changed') {
          state.validatedHeadSha = null;
          if ((await validateHead(await activities.getPrSnapshot(input.prRef))) === 'blocked') {
            if (state.blockReason === 'provider-refused') {
              state.phase = 'blocked';
              state.outcome = 'blocked';
              return state;
            }
            if ((await waitAtBrake('repair-brake')) === 'cancelled') return state;
          }
          continue;
        }
        state.phase = 'blocked';
        state.outcome = 'blocked';
        state.blockReason = merge.kind === 'forbidden' ? 'permission-denied' : 'provider-refused';
        return state;
      }

      if (decision === 'braked') {
        state.blockReason = 'babysit-brake';
        if ((await waitAtBrake('babysit-brake')) === 'cancelled') return state;
        // Human resumed: lift both no-progress caps so continued babysitting
        // isn't instantly re-braked, and restart the counter.
        maxBabysitWaits = Number.MAX_SAFE_INTEGER;
        maxPendingWaits = Number.MAX_SAFE_INTEGER;
        waiting = 0;
        continue;
      }

      if (decision === 'actionable') {
        waiting = 0;
        seen.add(feedbackHash(feedback));
        state.babysitRounds += 1;
        const reviewComments = feedback.comments
          .filter((c) => !c.resolved)
          .map((c) => c.body)
          .join('\n\n---\n\n');
        state.phase = 'repairing';
        state.implementAttempts += 1;
        state.iterations += 1;
        // implement.md requires all three keys (see the validateHead repair note).
        // The babysit path is triggered by red CI and/or unresolved review
        // threads, so surface the CI-failure signal as the verify finding and the
        // review threads as the feedback. (Detailed failing-check logs aren't in
        // PrFeedback yet -- tracked separately.)
        await runStageAgent('implement', state.implementAttempts, {
          fullVerifyFindings:
            feedback.ciStatus === 'failed'
              ? 'CI checks are failing on this PR. Inspect the failing checks and their logs in the forge, then fix the root cause.'
              : '',
          reviewFindings: '',
          prReviewFeedback: reviewComments,
        });
        await activities.pushBranch(
          input.repo,
          state.workspaceRef,
          state.branch,
          `${input.taskId}-${state.implementAttempts}`,
        );
        if (
          (await validateHead(await activities.getPrSnapshot(input.prRef), reviewComments)) ===
          'blocked'
        ) {
          if (state.blockReason === 'provider-refused') {
            state.phase = 'blocked';
            state.outcome = 'blocked';
            return state;
          }
          if ((await waitAtBrake('repair-brake')) === 'cancelled') return state;
        }
        continue;
      }

      waiting += 1;
    }
  }

  async function land(): Promise<PrLandingState> {
    const snapshot = await activities.getPrSnapshot(input.prRef);
    state.currentHeadSha = snapshot.headSha;
    if (state.validatedHeadSha !== snapshot.headSha) {
      state.validatedHeadSha = null;
      if ((await validateHead(snapshot)) === 'blocked') {
        if (state.blockReason === 'provider-refused') {
          state.phase = 'blocked';
          state.outcome = 'blocked';
          return state;
        }
        if ((await waitAtBrake('repair-brake')) === 'cancelled') return state;
      }
    }
    return babysitAndMerge();
  }

  const initialSnapshot = await activities.getPrSnapshot(input.prRef);
  let ownsWorkspace = false;
  try {
    if (input.workspace) {
      state.workspaceRef = input.workspace.workspaceRef;
      state.branch = input.workspace.branch;
      state.validatedHeadSha = input.workspace.validatedHeadSha;
    } else {
      const prepared = await activities.prepareWorkspace({
        taskId: input.taskId,
        repo: input.repo,
        initCommands: config.initCommands ?? [],
        headBranch: input.headBranch,
        headRef: initialSnapshot.checkoutRef,
      });
      state.workspaceRef = prepared.workspaceRef;
      state.branch = prepared.branch;
    }
    ownsWorkspace = true;
    return await land();
  } catch (err) {
    if (err instanceof PrLandingCancelledError) {
      state.phase = 'done';
      state.outcome = 'cancelled';
      return state;
    }
    state.phase = 'done';
    state.outcome = 'failed';
    return state;
  } finally {
    if (ownsWorkspace) await activities.cleanupWorkspace(state.workspaceRef, input.repo);
  }
}
