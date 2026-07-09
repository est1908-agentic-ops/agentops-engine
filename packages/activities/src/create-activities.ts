import { trace } from '@opentelemetry/api';
import {
  LiteLlmBudgetExceededError,
  ProcessCliAuthError,
  RateWindowExceededError,
  type AgentBackend,
} from '@agentops/backends';
import {
  normalizeRepo,
  type Issue,
  type OpenPrRequest,
  type OpenPrResult,
  type ScmPort,
  type TrackerPort,
} from '@agentops/ports';
import type {
  AgentRunRequest,
  AgentRunResult,
  PrFeedback,
  ProjectConfig,
  ResolvedProjectEntry,
  RunStats,
} from '@agentops/contracts';
import { parseProjectConfig } from '@agentops/contracts';
import type { PromptPack } from '@agentops/prompts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';
import {
  WorkspaceError,
  type PreparedWorkspace,
  type Workspaces,
} from './workspace/workspace-manager';
import { loadProjectConfig } from './load-project-config';
import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
  registry: ResolvedProjectEntry[];
  heartbeat?: (details: unknown) => void;
}

function rethrowWorkspaceError(err: unknown): never {
  if (err instanceof WorkspaceError && err.nonRetryable) {
    throw ApplicationFailure.nonRetryable(err.message, 'WorkspaceError');
  }
  throw err;
}

export function createActivities(deps: ActivityDependencies) {
  const heartbeat = deps.heartbeat ?? ((details: unknown) => Context.current().heartbeat(details));
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      heartbeat({
        phase: 'started',
        taskId: req.taskId,
        stage: req.stage,
        attempt: req.attempt,
        callIndex: req.callIndex,
        backend: req.backend,
        model: req.model,
      });
      try {
        const result = await backend.run({
          taskId: req.taskId,
          stage: req.stage,
          attempt: req.attempt,
          callIndex: req.callIndex,
          backend: req.backend,
          model: req.model,
          effort: req.effort,
          image: req.image,
          services: req.services,
          workspaceRef: req.workspaceRef,
          limits: req.limits,
          prompt,
        });
        // gen_ai.* are the OTel semantic-convention attribute names for LLM
        // usage. There's no per-call granularity available today (the CLI
        // returns one aggregate usage total per invocation, see the design
        // doc), so these land on this activity's own span rather than
        // separate child spans.
        trace.getActiveSpan()?.setAttributes({
          'gen_ai.system': req.backend,
          'gen_ai.request.model': req.model,
          'gen_ai.usage.input_tokens': result.tokensIn,
          'gen_ai.usage.output_tokens': result.tokensOut,
          'agentops.stage': req.stage,
          'agentops.attempt': req.attempt,
        });
        return result;
      } catch (err) {
        // A LiteLLM virtual-key budget cap is definitive, not transient --
        // same "typed error at the boundary, non-retryable ApplicationFailure
        // here" shape as rethrowWorkspaceError below.
        if (err instanceof LiteLlmBudgetExceededError) {
          throw ApplicationFailure.nonRetryable(err.message, 'LiteLlmBudgetExceededError');
        }
        // A rejected credential (bad/expired/revoked token, placeholder key) is
        // definitive, not transient -- retrying just burns the activity's retry
        // budget and delays surfacing the real cause. Fail fast with a clearly
        // typed, non-retryable failure so it reads as an auth problem in Temporal.
        if (err instanceof ProcessCliAuthError) {
          throw ApplicationFailure.nonRetryable(err.message, 'AuthError');
        }
        // A subscription rate window is a scheduling fact, not something a
        // human needs to resolve -- retryable, with nextRetryDelay set to
        // exactly how long until a slot frees up, so Temporal's own activity
        // retry waits it out without ever surfacing as a blocked workflow.
        if (err instanceof RateWindowExceededError) {
          throw ApplicationFailure.create({
            message: err.message,
            type: 'RateWindowExceededError',
            nonRetryable: false,
            nextRetryDelay: err.retryAfterMs,
          });
        }
        throw err;
      }
    },
    async getIssue(ref: string): Promise<Issue> {
      return deps.tracker.getIssue(ref);
    },
    async commentOnIssue(ref: string, body: string): Promise<void> {
      await deps.tracker.comment(ref, body);
    },
    async labelIssue(ref: string, label: string): Promise<void> {
      await deps.tracker.label(ref, label);
    },
    async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
      return deps.scm.openPr(req);
    },
    async getPrFeedback(prRef: string): Promise<PrFeedback> {
      return deps.scm.getPrFeedback(prRef);
    },
    async pushBranch(
      repo: string,
      workspaceRef: string,
      branch: string,
      contentHash: string,
    ): Promise<void> {
      await deps.scm.push(repo, workspaceRef, branch, contentHash);
    },
    async recordStageResult(result: StageResultRecord): Promise<void> {
      deps.stageResults.record(result);
    },
    async recordRunStats(stats: RunStats): Promise<void> {
      await deps.stats.record(stats);
    },
    async prepareWorkspace(req: {
      taskId: string;
      repo: string;
      initCommands?: string[];
    }): Promise<PreparedWorkspace> {
      try {
        return await deps.workspaces.prepare(req.taskId, req.repo, req.initCommands);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      try {
        await deps.workspaces.cleanup(workspaceRef, repo);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
    async resolveRepoConfig(
      repo: string,
    ): Promise<{ registered: boolean; project: string; config: ProjectConfig }> {
      const target = normalizeRepo(repo);
      const entry = deps.registry.find((candidate) => normalizeRepo(candidate.repo) === target);
      if (!entry) {
        // No project registry entry means no SCM credentials scoped to this
        // repo either -- loadProjectConfig would just throw via the
        // project-scoped ScmPort. Short-circuit instead of letting that
        // throw bubble up as a fatal, deterministically-unretryable activity
        // failure (see platform.ts, which treats `registered: false` as
        // "skip this proposed fix" rather than crashing the whole run).
        return { registered: false, project: 'default', config: parseProjectConfig({}) };
      }
      const config = await loadProjectConfig(deps.scm, repo);
      return { registered: true, project: entry.project, config };
    },
    async prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }> {
      try {
        return await deps.workspaces.prepareScratch(taskId);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
    async cleanupScratchWorkspace(workspaceRef: string): Promise<void> {
      try {
        await deps.workspaces.cleanupScratch(workspaceRef);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
