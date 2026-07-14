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
import type { Brakes, DevCycleState, ProjectConfig, Routing, TaskInput, VerdictKind } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages, resolveStageLimits } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

// No step retries forever: a failure that keeps recurring attempt after attempt
// (a bad git ref, a repo that no longer exists, a deterministic backend error) is
// never going to be fixed by trying again, and unbounded retries leave a workflow
// silently stuck with no signal short of a human noticing it in the Temporal UI.
// maximumAttempts caps every activity to a small number of tries before the
// workflow fails the way any other unhandled error does.
const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

export const stopSignal = defineSignal('stop');
export const cancelSignal = defineSignal('cancel');
export const clarifySignal = defineSignal<[string]>('clarify');
export const resumeSignal = defineSignal('resume');
export const stateQuery = defineQuery<DevCycleState>('state');

// Re-exported so existing importers (e2e/helpers.ts, control) keep resolving
// DevCycleState from @agentops/workflows; the schema lives in contracts.
export type { DevCycleState } from '@agentops/contracts';

const MAX_VERDICT_CALLS = 2;
const DEFAULT_BABYSIT_POLL_MS = 5000;
// Cap on consecutive no-progress babysit polls before blocking for a human. A
// `waiting` round never advances `maxBabysitRounds` (only `actionable` repair
// rounds do), so a PR whose CI never resolves -- e.g. GitHub Actions checks the
// project token can't read, so getPrFeedback returns `pending` on every poll --
// would otherwise poll forever. ~20 min of no actionable change -> braked
// (resumable), rather than an unbounded spin. See devcycle:Artem private agents.
const MAX_BABYSIT_WAIT_MS = 20 * 60_000;
const MAX_BABYSIT_WAITS = Math.ceil(MAX_BABYSIT_WAIT_MS / DEFAULT_BABYSIT_POLL_MS);

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
  // Assigned right after config resolution below. Only the signal handlers
  // close over it before then, and none can meaningfully fire before the
  // first stage can possibly block.
  let effectiveBrakes: Brakes;

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

  // Prompt-started runs (control BFF) pass no config -- resolve it here on
  // the worker, which holds the credential private key and the merged
  // static+managed registry (prompt-devcycle design §3/§5). Gateway, CLI,
  // and platform-children keep pre-resolving and passing config as before.
  let config: ProjectConfig;
  if (input.config) {
    config = input.config;
  } else {
    const resolved = await activities.resolveRepoConfig(input.repo);
    if (!resolved.registered) {
      // Repo unknown to this worker's registry -- e.g. registered in the
      // console after the worker last booted (design §7). Fail fast with an
      // explicit reason instead of crashing later in prepareWorkspace.
      state.stage = 'failed';
      state.status = 'failed';
      state.blockReason = 'unregistered-repo';
      return state;
    }
    config = resolved.config;
  }
  effectiveBrakes = { ...config.brakes };

  const prepared = await activities.prepareWorkspace({
    taskId: input.taskId,
    repo: input.repo,
    initCommands: config.initCommands,
  });
  state.workspaceRef = prepared.workspaceRef;
  state.branch = prepared.branch;

  const dropAgentWorking = async (): Promise<void> => {
    if (input.issueRef) {
      await activities.unlabelIssue(input.issueRef, 'agent:working');
    }
  };

  let issueBody = '';
  let issueLabels: string[] = [];
  if (input.issueRef) {
    const issue = await activities.getIssue(input.issueRef);
    issueBody = issue.body;
    issueLabels = issue.labels;
    await activities.labelIssue(input.issueRef, 'agent:working');
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
    tierOverride?: string,
    extraContext: Record<string, unknown> = {},
  ): Promise<string> => {
    const routed = config.routing[stage];
    const tier = tierOverride ?? routed?.tier ?? 'smart';
    const effort = routed?.effort;

    let result;
    while (true) {
      try {
        result = await agentActivities.runAgent({
          taskId: input.taskId,
          stage,
          attempt,
          callIndex,
          tier,
          effort,
          projectTiers: config.tiers,
          image: config.image,
          services: config.services,
          promptRef: `${stage}.md`,
          promptContext: { taskId: input.taskId, goal: input.goal, ...extraContext },
          workspaceRef: state.workspaceRef,
          limits: { maxTokens: config.brakes.maxTokens, ...resolveStageLimits(config, stage) },
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
      backend: result.resolvedBackend ?? 'unknown',
      model: result.resolvedModel ?? 'unknown',
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
    for (const stage of preImplementStages({ config, hasHumanDesign: false, hasHumanPlan: false })) {
      state.stage = stage;
      const extraContext = stage === 'context' ? { issueBody } : {};
      await runStageAgent(stage as RoutableStage, 1, 1, undefined, extraContext);
      if (cancelled) {
        state.stage = 'failed';
        state.status = 'failed';
        await dropAgentWorking();
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
      const escalationTier = useEscalation ? config.escalation?.tier : undefined;
      const implementOutput = await runStageAgent('implement', implementAttempt, 1, escalationTier, {
        fullVerifyFindings: lastFullVerifyOutput,
        reviewFindings: lastReviewOutput,
        prReviewFeedback: '',
      });
      state.implementAttempts = implementAttempt;
      state.iterations += 1;
      const diffEmpty = implementOutput.trim().length === 0;

      state.stage = 'full_verify';
      const verifyCommands =
        [...(config.fastVerifyCommands ?? []), ...(config.fullVerifyCommands ?? [])].join('\n') ||
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
          hasEscalationModel: config.escalation != null,
        });

      let action = evaluate();
      while (action.kind === 'block') {
        state.status = 'blocked';
        state.blockReason = action.reason;
        if (await waitForResumeOrCancel()) {
          state.stage = 'failed';
          state.status = 'failed';
          await dropAgentWorking();
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
    await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-${implementAttempt}`);

    // Read the committed design/plan artifacts from the canonical superpowers locations
    // (right after the final push, before opening the PR — per design).
    const designPath = `docs/superpowers/specs/${input.taskId}-design.md`;
    const planPath = `docs/superpowers/plans/${input.taskId}-plan.md`;

    const [designContent, planContent] = await Promise.all([
      activities.readWorkspaceFile(state.workspaceRef, designPath),
      activities.readWorkspaceFile(state.workspaceRef, planPath),
    ]);

    const findingsSummary = `full_verify: ${fullVerifyVerdict}; review: ${reviewVerdict ?? 'not-run'}`;
    const prBody = buildRichPrBody({
      taskId: input.taskId,
      goal: input.goal,
      issueRef: input.issueRef,
      issueBody,
      designContent,
      planContent,
      exhausted,
      implementAttempts: state.implementAttempts,
      iterations: state.iterations,
      cumulativeTokens: state.cumulativeTokens,
      findingsSummary,
    });

    const { prRef } = await activities.openPr({
      repo: input.repo,
      branch: state.branch,
      title: input.goal,
      body: prBody,
      labels: issueLabels.length > 0 ? issueLabels : undefined,
    });
    state.prRef = prRef;
    await dropAgentWorking();
    if (exhausted) {
      await activities.commentOnIssue(input.issueRef ?? input.taskId, prBody);
    }

    state.stage = 'pr_babysit';
    const seenFeedbackHashes = new Set<string>();
    let waitingRounds = 0;
    // Lifted to unbounded once a human resumes a babysit brake -- same escape
    // hatch as maxBabysitRounds (see resumeSignal): after "keep going" we don't
    // want the loop to immediately re-brake.
    let maxBabysitWaits = MAX_BABYSIT_WAITS;

    while (true) {
      await sleep(DEFAULT_BABYSIT_POLL_MS);
      const feedback = await activities.getPrFeedback(prRef);
      const decision = babysitDecision(
        feedback,
        seenFeedbackHashes,
        state.babysitRounds,
        effectiveBrakes.maxBabysitRounds,
        waitingRounds,
        maxBabysitWaits,
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
          await dropAgentWorking();
          await activities.cleanupWorkspace(state.workspaceRef, input.repo);
          return state;
        }
        // Human resumed: stop auto-braking (the round cap is lifted by
        // resumeSignal; lift the no-progress cap here too) and restart the
        // no-progress counter so continued babysitting isn't instantly re-braked.
        maxBabysitWaits = Number.MAX_SAFE_INTEGER;
        waitingRounds = 0;
        state.stage = 'pr_babysit';
        continue;
      }

      if (decision === 'actionable') {
        waitingRounds = 0; // real progress -- reset the no-progress counter
        seenFeedbackHashes.add(feedbackHash(feedback));
        state.babysitRounds += 1;
        implementAttempt += 1;
        state.stage = 'implement';
        const reviewComments = feedback.comments
          .filter(c => !c.resolved)
          .map(c => c.body)
          .join('\n\n---\n\n');
        await runStageAgent('implement', implementAttempt, 1, undefined, {
          fullVerifyFindings: lastFullVerifyOutput,
          reviewFindings: lastReviewOutput,
          prReviewFeedback: reviewComments || '',
        });
        state.implementAttempts = implementAttempt;
        state.iterations += 1;
        await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-${implementAttempt}`);
        state.stage = 'pr_babysit';
        continue;
      }

      // decision === 'waiting': no actionable signal this poll. Count it toward
      // the no-progress cap, then loop again after the next poll interval.
      waitingRounds += 1;
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
    await dropAgentWorking();
    await activities.cleanupWorkspace(state.workspaceRef, input.repo);
    return state;
  }
}

/** Pure helper: extract the explicit Brainstorm Summary section (added in design prompt). */
function extractBrainstormSummary(design: string | null): string {
  if (!design) return '(design phase was skipped or produced no artifact)';
  const marker = '## Brainstorm Summary';
  const start = design.indexOf(marker);
  if (start === -1) {
    // fallback: take a short prefix of the design
    return design.slice(0, 600) + (design.length > 600 ? '\n...(truncated)' : '');
  }
  const rest = design.slice(start + marker.length);
  const end = rest.indexOf('\n## ');
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  return body || '(empty summary)';
}

interface BuildPrBodyInput {
  taskId: string;
  goal: string;
  issueRef?: string;
  issueBody?: string;
  designContent: string | null;
  planContent: string | null;
  exhausted: boolean;
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  findingsSummary: string;
}

function buildRichPrBody(input: BuildPrBodyInput): string {
  const { taskId, goal, issueRef, issueBody, designContent, planContent, exhausted, implementAttempts, iterations, cumulativeTokens, findingsSummary } = input;

  const fixesLine = issueRef ? `Fixes ${issueRef}\n\n` : '';

  const problemSection = issueBody
    ? (() => {
        const lines = issueBody.split(/\r?\n/);
        const excerpt = lines.slice(0, 10).join('\n').trim();
        const truncated = lines.length > 10 || excerpt.length > 700;
        return `## Problem\n\n> ${excerpt}${truncated ? '\n\n(truncated)' : ''}\n\n`;
      })()
    : `## Problem\n\n${goal}\n\n`;

  const brainstorm = extractBrainstormSummary(designContent);

  const howWhy = planContent
    ? `Followed the plan in the committed artifact (see below). Key approach from design phase.`
    : (designContent ? 'Implemented the chosen design.' : 'Direct implementation (no separate design/plan stage).');

  const body = `${fixesLine}${problemSection}## Design Brainstorm Summary

${brainstorm}

## How the fix was done and why

${howWhy}

See the full committed artifacts in this PR:
- \`docs/superpowers/specs/${taskId}-design.md\`
- \`docs/superpowers/plans/${taskId}-plan.md\`

${exhausted ? `**Repair attempts exhausted** after ${implementAttempts} implement attempt(s).\n` : ''}

**Run metadata**
- Iterations: ${iterations}
- Implement attempts: ${implementAttempts}
- Tokens used: ${cumulativeTokens}
- Verify / review: ${findingsSummary}

---
**To let the agent automatically address review comments** on this and future PRs, make sure your repository webhook sends **Pull request reviews** events (in addition to Issues events).

Generated by agentops-engine devCycle
`;

  return body;
}
