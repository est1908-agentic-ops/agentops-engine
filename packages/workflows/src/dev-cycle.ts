import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { BlockReason, Brakes, Routing, Stage, TaskInput, TaskStatus, VerdictKind } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
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
}

const MAX_VERDICT_CALLS = 2;
const DEFAULT_BABYSIT_POLL_MS = 5000;

export async function devCycle(input: TaskInput): Promise<DevCycleState> {
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

  const waitForResumeOrCancel = async (): Promise<boolean> => {
    await condition(() => cancelled || state.status === 'running');
    return cancelled;
  };

type RoutableStage = keyof Routing;

  const runStageAgent = async (
    stage: RoutableStage,
    attempt: number,
    callIndex = 1,
    modelOverride?: { backend: string; model: string },
  ): Promise<string> => {
    const routed = input.config.routing[stage];
    const model = modelOverride ?? routed;
    const backend = model?.backend ?? 'stub';
    const modelName = model?.model ?? 'stub';
    const result = await activities.runAgent({
      taskId: input.taskId,
      stage,
      attempt,
      callIndex,
      backend,
      model: modelName,
      promptRef: `${stage}.md`,
      workspaceRef: input.repo,
      limits: { maxTokens: input.config.brakes.maxTokens, timeoutMs: 600_000 },
    });
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
  ): Promise<VerdictKind> => {
    let lastKind: VerdictKind = 'unparseable';
    for (let call = 1; call <= MAX_VERDICT_CALLS; call += 1) {
      const output = await runStageAgent(stage, attempt, call);
      const parsed = parseVerdict(output, sentinel);
      lastKind = parsed.kind;
      if (parsed.kind !== 'unparseable') {
        return parsed.kind;
      }
    }
    return lastKind === 'unparseable' ? 'fail' : lastKind;
  };

  if (input.issueRef) {
    await activities.getIssue(input.issueRef);
  }

  for (const stage of preImplementStages({ config: input.config, hasHumanDesign: false, hasHumanPlan: false })) {
    state.stage = stage;
    await runStageAgent(stage as RoutableStage, 1);
    if (cancelled) {
      state.stage = 'failed';
      state.status = 'failed';
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

  while (true) {
    state.stage = 'implement';
    const implementModel = useEscalation ? input.config.escalation : undefined;
    const implementOutput = await runStageAgent('implement', implementAttempt, 1, implementModel);
    state.implementAttempts = implementAttempt;
    state.iterations += 1;
    const diffEmpty = implementOutput.trim().length === 0;

    state.stage = 'full_verify';
    fullVerifyVerdict = await runVerdictStage('full_verify', implementAttempt, 'FULL:');

    if (fullVerifyVerdict === 'pass') {
      state.stage = 'review';
      reviewVerdict = await runVerdictStage('review', reviewAttempt, 'VERDICT:');
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
  const branch = `agentops/${input.taskId}`;
  const findingsSummary = `full_verify: ${fullVerifyVerdict}; review: ${reviewVerdict ?? 'not-run'}`;
  const prBody = exhausted
    ? `Repair attempts exhausted after ${state.implementAttempts} implement attempt(s). Opening PR with outstanding findings.\n${findingsSummary}`
    : `Automated PR for task ${input.taskId}.`;
  const { prRef } = await activities.openPr({
    repo: input.repo,
    branch,
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
      await runStageAgent('implement', implementAttempt);
      state.implementAttempts = implementAttempt;
      state.iterations += 1;
      await activities.pushBranch(branch, `${input.taskId}-${implementAttempt}`);
      state.stage = 'pr_babysit';
      continue;
    }

    // decision === 'waiting': loop again after the next poll interval.
  }

  state.stage = 'done';
  state.status = 'done';
  return state;
}
