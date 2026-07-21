import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  ChatDecision,
  ChatMessage,
  ConversationState,
  PlatformAction,
  PlatformChatCarry,
  PlatformChatInput,
  PlatformChatResult,
  TaskInput,
} from '@agentops/contracts';
import { PlatformChatResultSchema } from '@agentops/contracts';
import { parseChatTurn, renderChatTranscript, slugifyProject } from '@agentops/policies';
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

// v1 reuses the platform backend (spec §5). Switch to 'platformChat' once the
// read-only credential profile lands (spec §12). `stage: 'platform'` reuses the
// existing StageSchema member -- do not add a new one (AGENTS.md).
const CHAT_TIER = 'platform';
const CHAT_MAX_TOKENS = 400_000;
const CHAT_TIMEOUT_MS = 1_800_000;
const CHAT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // auto-close a chat idle for 30 min
const MAX_TURN_CALLS = 2; // re-ask once on an unparseable turn (mirrors platform.ts)
const TRANSCRIPT_WINDOW = 20; // messages fed back to the agent each turn
const CONTINUE_AS_NEW_AFTER = 200; // bound Temporal event history

export const userTurnSignal = defineSignal<[string]>('userTurn');
export const decisionSignal = defineSignal<[ChatDecision]>('decision');
export const closeSignal = defineSignal('close');
export const conversationQuery = defineQuery<ConversationState>('conversation');

export async function platformChat(
  input: PlatformChatInput,
  carry?: PlatformChatCarry,
): Promise<PlatformChatResult> {
  const chatId = workflowInfo().workflowId;

  const messages: ChatMessage[] = carry ? [...carry.messages] : [];
  let seq = carry?.seq ?? 0;
  let phase: ConversationState['phase'] = 'awaiting-user';
  let pendingProposal: ConversationState['pendingProposal'];
  let pendingUserText: string | undefined;
  let pendingDecision: ChatDecision | undefined;
  let closed = false;

  const actionsExecuted: PlatformAction[] = carry?.actionsExecuted ? [...carry.actionsExecuted] : [];
  const childWorkflows: PlatformChatResult['childWorkflows'] = carry?.childWorkflows ? [...carry.childWorkflows] : [];

  const push = (role: ChatMessage['role'], text: string, kind?: ChatMessage['kind']): void => {
    seq += 1;
    messages.push({ seq, role, text, kind });
  };

  setHandler(conversationQuery, () => ({ chatId, phase, messages, pendingProposal }));
  setHandler(userTurnSignal, (text: string) => {
    pendingUserText = text;
  });
  setHandler(decisionSignal, (decision: ChatDecision) => {
    pendingDecision = decision;
  });
  setHandler(closeSignal, () => {
    closed = true;
  });

  // Prepare a scratch workspace once and reuse it across turns; carry it across
  // continueAsNew so the running conversation keeps the same workspace.
  const workspaceRef =
    carry?.workspaceRef ?? (await activities.prepareScratchWorkspace(chatId)).workspaceRef;

  // Seed the optional first prompt as the first operator turn.
  if (!carry && input.prompt) {
    pendingUserText = input.prompt;
  }

  while (true) {
    const gotInput = await condition(
      () => pendingUserText !== undefined || pendingDecision !== undefined || closed,
      CHAT_IDLE_TIMEOUT_MS,
    );
    if (!gotInput || closed) {
      break; // idle timeout or explicit close
    }

    if (pendingUserText !== undefined) {
      push('user', pendingUserText, 'reply');
      pendingUserText = undefined;
      pendingProposal = undefined; // a free-text turn supersedes any open question/proposal
    } else if (pendingDecision !== undefined) {
      const decision = pendingDecision;
      pendingDecision = undefined;
      const proposal = pendingProposal;
      pendingProposal = undefined;
      if (!proposal || proposal.id !== decision.proposalId) {
        push('system', `decision for unknown proposal "${decision.proposalId}" ignored`, 'error');
        phase = 'awaiting-user';
        continue;
      }
      if (!decision.approve) {
        push(
          'system',
          `Operator rejected: ${proposal.reason}${decision.note ? ` — ${decision.note}` : ''}`,
          'decision',
        );
      } else if (proposal.type === 'fix') {
        const resolved = await activities.resolveRepoConfig(proposal.repo ?? '');
        if (!resolved.registered) {
          push(
            'system',
            `cannot fix "${proposal.repo}": no project registered for that repo`,
            'error',
          );
        } else {
          // Same slug-vs-readable split as platform.ts: keep chatId-derived workflowId
          // (which may contain special chars) for Temporal visibility, slug only the
          // taskId used for git branch and agent task identity.
          const childWorkflowId = `${chatId}-fix-${childWorkflows.length + 1}`;
          const childTaskId = `${slugifyProject(chatId)}-fix-${childWorkflows.length + 1}`;
          const taskInput: TaskInput = {
            taskId: childTaskId,
            project: resolved.project,
            repo: proposal.repo!,
            goal: proposal.goal ?? proposal.reason,
            config: resolved.config,
          };
          await executeChild(devCycle, { workflowId: childWorkflowId, args: [taskInput] });
          childWorkflows.push({
            workflowId: childWorkflowId,
            repo: proposal.repo!,
            goal: taskInput.goal,
          });
          push(
            'system',
            `Started fix devCycle ${childWorkflowId} for ${proposal.repo}`,
            'action-result',
          );
        }
      } else {
        const res = await activities.executePlatformAction({
          type: proposal.type,
          workflowId: proposal.workflowId ?? '',
          signalName: proposal.signalName,
          reason: proposal.reason,
        });
        push('system', res.detail, 'action-result');
        if (res.ok) {
          actionsExecuted.push({
            type: proposal.type,
            workflowId: proposal.workflowId!,
            reason: proposal.reason,
          });
        }
      }
    }

    // Run one agent turn over the windowed transcript.
    phase = 'agent-thinking';
    const windowed = messages.slice(-TRANSCRIPT_WINDOW);
    let turn;
    for (let call = 1; call <= MAX_TURN_CALLS; call += 1) {
      const result = await agentActivities.runAgent({
        taskId: chatId,
        stage: 'platform',
        // `taskId` is constant for the whole chat (unlike the one-shot `platform`
        // workflow, where every run gets a fresh taskId), so a hardcoded `attempt: 1`
        // would build the identical K8s Job name/output path on every turn --
        // K8sJobRunner only cleans up a Job on failure, so turn 2+ would 409-reuse
        // turn 1's already-succeeded Job and replay its stale output forever
        // instead of re-running the agent. `seq` is already carried across
        // continueAsNew and strictly increases before every runAgent call (a
        // message is always pushed first), so it doubles as a collision-free
        // per-turn attempt number.
        attempt: seq,
        callIndex: call,
        tier: CHAT_TIER,
        promptRef: 'platform-chat.md',
        promptContext: {
          taskId: chatId,
          transcript: renderChatTranscript(windowed),
          hintRepos: (input.hintRepos ?? []).join(', ') || '(none provided)',
        },
        workspaceRef,
        limits: {
          maxTokens: CHAT_MAX_TOKENS,
          idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS,
          timeoutMs: CHAT_TIMEOUT_MS,
        },
      });
      await activities.recordRunStats({
        taskId: chatId,
        stage: 'platform',
        backend: result.resolvedBackend ?? 'unknown',
        model: result.resolvedModel ?? 'unknown',
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        wallMs: result.wallMs,
        outcome: 'pass',
      });
      const parsed = parseChatTurn(result.output);
      if (parsed.parseable) {
        turn = parsed.turn;
        break;
      }
    }

    if (!turn) {
      push(
        'agent',
        'I could not produce a well-formed response. Please rephrase or try again.',
        'error',
      );
      phase = 'awaiting-user';
      continue;
    }

    if (turn.pending?.kind === 'proposal') {
      seq += 1;
      pendingProposal = { ...turn.pending.proposal, id: `p-${seq}` };
      messages.push({ seq, role: 'agent', text: turn.message, kind: 'proposal' });
      phase = 'awaiting-approval';
    } else if (turn.pending?.kind === 'question') {
      push('agent', turn.message, 'question');
      phase = 'awaiting-answer';
    } else {
      push('agent', turn.message, 'reply');
      phase = 'awaiting-user';
      if (turn.done) {
        closed = true;
        break;
      }
    }

    // Bound Temporal history on long-running chats. Only continue-as-new from a
    // quiescent point (awaiting-user) so we never drop a pending proposal.
    if (messages.length >= CONTINUE_AS_NEW_AFTER && phase === 'awaiting-user') {
      await continueAsNew<typeof platformChat>(input, {
        messages,
        seq,
        workspaceRef,
        actionsExecuted,
        childWorkflows,
      });
    }
  }

  // Reached only on real close / idle timeout / done -- never on continueAsNew
  // (which unwinds above). Safe to release the scratch workspace here.
  await activities.cleanupScratchWorkspace(workspaceRef);
  phase = 'closed';
  return PlatformChatResultSchema.parse({
    turns: messages.filter((m) => m.role === 'agent').length,
    actionsExecuted,
    childWorkflows,
  });
}
