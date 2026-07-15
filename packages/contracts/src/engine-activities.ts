import type { AgentRunRequest, AgentRunResult } from './agent-run';
import type { Issue, CreateIssueInput, CreateIssueResult } from './tracker-types';

// The delegatable engine activity surface exposed to Tier-2 project workflows
// via @agentic-ops/engine-sdk/workflow. This interface + the child-workflow names
// (devCycle) + ENGINE_QUEUE are the published semver compatibility contract
// (SP2 design §3.2). Deliberately minimal — heavy SCM/workspace ops (real repo
// clones, project config resolution) stay internal to devCycle, reached via
// childDevCycle. prepareScratchWorkspace/cleanupScratchWorkspace are the one
// exception: they hold no repo/token (just a scratch dir keyed by taskId, the
// same primitive `platform`/`platform-chat` already use), so they're safe to
// expose directly — this is what lets a Tier-2 workflow call `runAgent` with
// the generic `agent` stage/prompt at all (see docs/authoring-project-workflows.md).
export interface EngineActivities {
  runAgent(
    req: AgentRunRequest,
  ): Promise<AgentRunResult & { promptHash: string; promptSource: string }>;
  createIssue(req: CreateIssueInput): Promise<CreateIssueResult>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
}
