import { trace } from '@opentelemetry/api';
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
import type { BlockReason, Brakes, ModelRef, Routing, Stage, TaskInput, TaskStatus, VerdictKind } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
});

const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '15s',
});

export const stopSignal = defineSignal('stop');
export const cancelSignal = defineSignal('cancel');
export const clarifySignal = defineSignal<[string]>('clarify');
export const resumeSignal = defineSignal('resume');
export const stateQuery = defineQuery<DevCycleState>('state');

export interface DevCycleState {
  taskId: string;
  stage: Stage;
  status: TaskStatus;
  blockReason: BlockReason | null;
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  babysitRounds: number;
  prRef: string | null;
  workspaceRef: string;
  branch: string;
}

const MAX_VERDICT_CALLS = 2;
const DEFAULT_BABYSIT_POLL_MS = 5000;

// Thrown only by runStageAgent, to unwind out to devCycle's top-level catch
// when a cancel signal arrives while blocked on a budget-exceeded retry loop
// -- the other blockReasons' cancel handling lives inline (checked right
// after their own call sites) because they don't retry-in-place the way a
// budget block does.
class DevCycleCancelledError extends Error {}

function isBudgetExceededFailure(err: unknown): boolean {
  return (
    err instanceof ActivityFailure &&
    err.cause instanceof ApplicationFailure &&
    err.cause.type === 'LiteLlmBudgetExceededError'
  );
}

export async function devCycle(input: TaskInput): Promise<DevCycleState> {
  // Only reads/mutates the span object the workflow-side OTel interceptor
  // already made active for this execution -- no wall-clock read, I/O, or
  // randomness, so this stays within the determinism boundary (AGENTS.md
  // hard rule #1) the same way the interceptor package itself does.
  trace.getActiveSpan()?.setAttributes({
    'agentops.task_id': input.taskId,
    'agentops.repo': input.repo,
  });

  const state: DevCycleState = {
    taskId: input.taskId,
    stage: 'context',
    status: 'running',
    blockReason: null,
    implementAttempts: 0,
    iterations: 0,
    cumulativeTokens: 0,
    babysitRounds: 0,
    prRef: null,
    workspaceRef: '',
    branch: '',
  };

  let cancelled = false;
  let stopRequested = false;
  let effectiveBrakes: Brakes = { ...input.config.brakes };

  setHandler(stopSignal, () => {
    stopRequested = true;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(clarifySignal, (_text: string) => {
    // M0 stores no clarification text yet — later milestones feed it back into
    // the next stage's prompt via activities. The signal exists now so the
    // `clarify`/`resume` escape hatch (ARCHITECTURE.md §2) is wired end-to-end.
  });
  setHandler(resumeSignal, () => {
    if (state.blockReason === 'token-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxTokens: Number.MAX_SAFE_INTEGER };
    }
    if (state.blockReason === 'iteration-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxIterations: Number.MAX_SAFE_INTEGER };
    }
    if (state.blockReason === 'babysit-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxBabysitRounds: Number.MAX_SAFE_INTEGER };
    }
    state.status = 'running';
    state.blockReason = null;
  });
  setHandler(stateQuery, () => state);

  const prepared = await activities.prepareWorkspace({
    taskId: input.taskId,
    repo: input.repo,
    initCommands: input.config.initCommands,
  });
  state.workspaceRef = prepared.workspaceRef;
  state.branch = prepared.branch;

  let issueBody = '';
  if (input.issueRef) {
    const issue = await activities.getIssue(input.issueRef);
    issueBody = issue.body;
  }

  const waitForResumeOrCancel = async (): Promise<boolean> => {
    await condition(() => cancelled || state.status === 'running');
    return cancelled;
  };

  type RoutableStage = keyof Routing;

  const runStageAgent = async (
    stage: RoutableStage,
    attempt: number,
    callIndex = 1,
    modelOverride?: ModelRef,
    extraContext: Record<string, unknown> = {},
  ): Promise<string> => {
    const routed = input.config.routing[stage];
    const model = modelOverride ?? routed;
    const backend = model?.backend ?? 'stub';
    const modelName = model?.model ?? 'stub';

    let result;
    while (true) {
      try {
        result = await agentActivities.runAgent({
          taskId: input.taskId,
          stage,
          attempt,
          callIndex,
          backend,
          model: modelName,
          effort: model?.effort,
          image: input.config.image,
          services: input.config.services,
          promptRef: `${stage}.md`,
          promptContext: { taskId: input.taskId, goal: input.goal, ...extraContext },
          workspaceRef: state.workspaceRef,
          limits: { maxTokens: input.config.brakes.maxTokens, timeoutMs: 600_000 },
        });
        break;
      } catch (err) {
        if (!isBudgetExceededFailure(err)) {
          throw err;
        }
        // Not a token-count brake -- a LiteLLM virtual key's hard spend cap.
        // Same resume escape hatch as the other blockReasons (an operator
        // bumps the budget/rotates the key, then signals resume), but this
        // one retries the same call in place rather than relaxing a brake
        // counter and letting the outer loop re-evaluate.
        state.status = 'blocked';
        state.blockReason = 'budget-exceeded';
        if (await waitForResumeOrCancel()) {
          throw new DevCycleCancelledError();
        }
      }
    }
    state.cumulativeTokens += result.tokensIn + result.tokensOut;
    await activities.recordRunStats({
      taskId: input.taskId,
      stage,
      backend,
      model: modelName,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      wallMs: result.wallMs,
      outcome: 'pass',
    });
    await activities.recordStageResult({
      taskId: input.taskId,
      stage,
      source: 'agent',
      contentHash: `${stage}-${attempt}-${callIndex}`,
      tokens: result.tokensIn + result.tokensOut,
      outcome: 'pass',
    });
    return result.output;
  };

  const runVerdictStage = async (
    stage: 'full_verify' | 'review',
    attempt: number,
    sentinel: string,
    extraContext: Record<string, unknown> = {},
  ): Promise<{ kind: VerdictKind; output: string }> => {
    let lastKind: VerdictKind = 'unparseable';
    let lastOutput = '';
    for (let call = 1; call <= MAX_VERDICT_CALLS; call += 1) {
      const output = await runStageAgent(stage, attempt, call, undefined, extraContext);
      lastOutput = output;
      const parsed = parseVerdict(output, sentinel);
      lastKind = parsed.kind;
      if (parsed.kind !== 'unparseable') {
        return { kind: parsed.kind, output };
      }
    }
    return { kind: lastKind === 'unparseable' ? 'fail' : lastKind, output: lastOutput };
  };

  // Wrapped so a cancel signal received while runStageAgent is blocked
  // in-place on a budget-exceeded retry (which can happen at any stage, deep
  // inside this function) unwinds to one place rather than needing every
  // call site below to check for it — the pre-existing `cancelled` checks
  // right after each call site are untouched; this only catches the new
  // DevCycleCancelledError path.
  try {
    for (const stage of preImplementStages({ config: input.config, hasHumanDesign: false, hasHumanPlan: false })) {
      state.stage = stage;
      const extraContext = stage === 'context' ? { issueBody } : {};
      await runStageAgent(stage as RoutableStage, 1, 1, undefined, extraContext);
      if (cancelled) {
        state.stage = 'failed';
        state.status = 'failed';
        await activities.cleanupWorkspace(state.workspaceRef, input.repo);
        return state;
      }
      if (stopRequested) {
        state.status = 'pending';
        return state;
      }
    }

    let implementAttempt = 1;
    let reviewAttempt = 1;
    let useEscalation = false;
    let exhausted = false;
    let fullVerifyVerdict: VerdictKind = 'unparseable';
    let reviewVerdict: VerdictKind | null = null;
    let lastFullVerifyOutput = '';
    let lastReviewOutput = '';

    while (true) {
      state.stage = 'implement';
      const implementModel = useEscalation ? input.config.escalation : undefined;
      const implementOutput = await runStageAgent('implement', implementAttempt, 1, implementModel, {
        fullVerifyFindings: lastFullVerifyOutput,
        reviewFindings: lastReviewOutput,
      });
      state.implementAttempts = implementAttempt;
      state.iterations += 1;
      const diffEmpty = implementOutput.trim().length === 0;

      state.stage = 'full_verify';
      const verifyCommands =
        [...(input.config.fastVerifyCommands ?? []), ...(input.config.fullVerifyCommands ?? [])].join('\n') ||
        '(none configured — use your own judgment on the diff)';
      const fullVerifyResult = await runVerdictStage('full_verify', implementAttempt, 'FULL:', { verifyCommands });
      fullVerifyVerdict = fullVerifyResult.kind;
      lastFullVerifyOutput = fullVerifyResult.output;

      if (fullVerifyVerdict === 'pass') {
        state.stage = 'review';
        const reviewResult = await runVerdictStage('review', reviewAttempt, 'VERDICT:');
        reviewVerdict = reviewResult.kind;
        lastReviewOutput = reviewResult.output;
        reviewAttempt += 1;
      } else {
        reviewVerdict = null;
      }

      const evaluate = () =>
        nextRepairAction({
          implementAttempts: implementAttempt,
          iterations: state.iterations,
          cumulativeTokens: state.cumulativeTokens,
          fullVerify: fullVerifyVerdict,
          review: reviewVerdict ?? 'unparseable',
          diffEmpty,
          brakes: effectiveBrakes,
          hasEscalationModel: input.config.escalation != null,
        });

      let action = evaluate();
      while (action.kind === 'block') {
        state.status = 'blocked';
        state.blockReason = action.reason;
        if (await waitForResumeOrCancel()) {
          state.stage = 'failed';
          state.status = 'failed';
          await activities.cleanupWorkspace(state.workspaceRef, input.repo);
          return state;
        }
        action = evaluate();
      }

      if (action.kind === 'continue') {
        break;
      }
      if (action.kind === 'open-pr-exhausted') {
        exhausted = true;
        break;
      }
      useEscalation = action.useEscalationModel;
      implementAttempt += 1;
    }

    state.stage = 'pr';
    const findingsSummary = `full_verify: ${fullVerifyVerdict}; review: ${reviewVerdict ?? 'not-run'}`;
    const prBody = exhausted
      ? `Repair attempts exhausted after ${state.implementAttempts} implement attempt(s). Opening PR with outstanding findings.\n${findingsSummary}`
      : `Automated PR for task ${input.taskId}.`;
    const { prRef } = await activities.openPr({
      repo: input.repo,
      branch: state.branch,
      title: input.goal,
      body: prBody,
    });
    state.prRef = prRef;
    if (exhausted) {
      await activities.commentOnIssue(input.issueRef ?? input.taskId, prBody);
    }

    state.stage = 'pr_babysit';
    const seenFeedbackHashes = new Set<string>();

    while (true) {
      await sleep(DEFAULT_BABYSIT_POLL_MS);
      const feedback = await activities.getPrFeedback(prRef);
      const decision = babysitDecision(
        feedback,
        seenFeedbackHashes,
        state.babysitRounds,
        effectiveBrakes.maxBabysitRounds,
      );

      if (decision === 'merge_ready') {
        break;
      }

      if (decision === 'braked') {
        state.status = 'blocked';
        state.blockReason = 'babysit-brake';
        if (await waitForResumeOrCancel()) {
          state.stage = 'failed';
          state.status = 'failed';
          await activities.cleanupWorkspace(state.workspaceRef, input.repo);
          return state;
        }
        state.stage = 'pr_babysit';
        continue;
      }

      if (decision === 'actionable') {
        seenFeedbackHashes.add(feedbackHash(feedback));
        state.babysitRounds += 1;
        implementAttempt += 1;
        state.stage = 'implement';
        await runStageAgent('implement', implementAttempt, 1, undefined, {
          fullVerifyFindings: lastFullVerifyOutput,
          reviewFindings: lastReviewOutput,
        });
        state.implementAttempts = implementAttempt;
        state.iterations += 1;
        await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-${implementAttempt}`);
        state.stage = 'pr_babysit';
        continue;
      }

      // decision === 'waiting': loop again after the next poll interval.
    }

    state.stage = 'done';
    state.status = 'done';
    await activities.cleanupWorkspace(state.workspaceRef, input.repo);
    return state;
  } catch (err) {
    if (!(err instanceof DevCycleCancelledError)) {
      throw err;
    }
    state.stage = 'failed';
    state.status = 'failed';
    await activities.cleanupWorkspace(state.workspaceRef, input.repo);
    return state;
  }
}
