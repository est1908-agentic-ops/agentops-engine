import { executeChild, workflowInfo } from '@temporalio/workflow';
import type { PlatformAgentResult } from '@agentops/contracts';
import { platform } from './platform';

// Trigger input for a scheduled self-heal sweep (not an agent-stage template --
// this is the equivalent of what a human types into the console prompt box, so a
// constant is consistent with the console's hardcoded SUGGESTED_PROMPTS; see
// docs/superpowers/specs/2026-07-13-self-heal-design.md §5).
export const SELF_HEAL_PROMPT = [
  'You are running as a scheduled self-heal sweep.',
  'Enumerate workflow failures and terminations from roughly the last 30 minutes across the platform and its projects, using the Temporal visibility API (see the platform-ops skill, "Finding recent failures").',
  'Diagnose the genuine failures — ignore transient or expected closes.',
  'For each failure with a clear cause, propose a fix (this opens a PR via devCycle). Before proposing, check the repo for an already-open PR or branch addressing the same failure and skip duplicates.',
  'If nothing is actionable, finish immediately with an empty summary.',
  'Repos in scope: the agentops-engine and agentops-platform repos plus any registered projects.',
].join('\n');

// M6 "Heal" auto-trigger (design §2/§4): a thin scheduled wrapper that runs the
// existing one-shot platform agent with the self-heal prompt. Awaits the child so
// the schedule's overlap:SKIP policy serialises sweeps.
export async function selfHeal(): Promise<PlatformAgentResult> {
  const runId = workflowInfo().workflowId;
  return executeChild(platform, {
    workflowId: `${runId}-platform`,
    args: [{ prompt: SELF_HEAL_PROMPT }],
  });
}