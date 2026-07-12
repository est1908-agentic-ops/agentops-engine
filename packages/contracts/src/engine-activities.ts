import type { AgentRunRequest, AgentRunResult } from './agent-run';
import type { Issue, CreateIssueInput, CreateIssueResult } from './tracker-types';

// The delegatable engine activity surface exposed to Tier-2 project workflows
// via @agentic-ops/engine-sdk/workflow. This interface + the child-workflow names
// (devCycle) + ENGINE_QUEUE are the published semver compatibility contract
// (SP2 design §3.2). Deliberately minimal — heavy SCM/workspace ops stay
// internal to devCycle, reached via childDevCycle.
export interface EngineActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult & { promptHash: string; promptSource: string }>;
  createIssue(req: CreateIssueInput): Promise<CreateIssueResult>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
}
