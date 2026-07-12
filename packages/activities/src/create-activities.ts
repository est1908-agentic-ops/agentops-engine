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
import { parseProjectConfig, sha256, type AgentSpec } from '@agentops/contracts';
import { parseAgentsManifest, BUILTIN_WORKFLOW_INPUTS } from '@agentops/contracts';
import type { FiledFindingStore } from './filed-finding-store';
import type { ScheduleClientLike } from './schedule-ops';
import { ENGINE_QUEUE } from '@agentops/contracts';
import type { ReconcilePlan } from '@agentops/policies';
import { scheduleId } from '@agentops/policies';
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
import { assertProjectOwnsRepo } from './project-context';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
  registry: ResolvedProjectEntry[];
  filedFindings?: FiledFindingStore;
  scheduleClient?: ScheduleClientLike;
  taskQueue?: string;
  workflowClient?: WorkflowClientLike;
  heartbeat?: (details: unknown) => void;
}

export interface WorkflowClientLike {
  start?: (workflowType: string, opts: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  list?: (query?: string) => AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  getHandle?: (id: string) => { terminate?: (reason?: string) => Promise<void> };
}

function rethrowWorkspaceError(err: unknown): never {
  if (err instanceof WorkspaceError) {
    throw ApplicationFailure.create({
      message: err.message,
      type: 'WorkspaceError',
      nonRetryable: err.nonRetryable,
    });
  }
  throw err;
}

export function createActivities(deps: ActivityDependencies) {
  const heartbeat = deps.heartbeat ?? ((details: unknown) => Context.current().heartbeat(details));
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult & { promptHash: string; promptSource: string }> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      const promptHash = sha256(prompt);
      const promptSource = req.promptSource
        ? `${req.promptSource.repo}@${req.promptSource.commit}:${req.promptSource.path}`
        : `builtin:${req.promptRef}`;
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
          'agentops.prompt.hash': promptHash,
          'agentops.prompt.source': promptSource,
        });
        return { ...result, promptHash, promptSource };
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
    async createIssue(req: { repo: string; project: string; title: string; body: string; labels: string[]; dedupeFingerprint?: string }): Promise<{ ref: string; url: string; deduped: boolean }> {
      assertProjectOwnsRepo(req.repo, deps.registry);
      const filedFindings = deps.filedFindings;
      if (req.dedupeFingerprint && filedFindings) {
        const existing = await filedFindings.find(req.project, req.dedupeFingerprint);
        if (existing) {
          await filedFindings.record({ project: req.project, fingerprint: req.dedupeFingerprint, issueRef: existing.issueRef });
          return { ref: existing.issueRef, url: '', deduped: true };
        }
      }
      const created = await deps.tracker.createIssue({ repo: req.repo, title: req.title, body: req.body, labels: req.labels });
      if (req.dedupeFingerprint && filedFindings) {
        await filedFindings.record({ project: req.project, fingerprint: req.dedupeFingerprint, issueRef: created.ref });
      }
      return { ref: created.ref, url: created.url, deduped: false };
    },
    async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
      assertProjectOwnsRepo(req.repo, deps.registry);
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
      assertProjectOwnsRepo(repo, deps.registry);
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
      assertProjectOwnsRepo(req.repo, deps.registry);
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

    async loadAgentsManifest(project: string, repo: string): Promise<AgentSpec[]> {
      const raw = await deps.scm.readFile(repo, 'agents.json');
      if (raw === null) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      const manifest = parseAgentsManifest(parsed, { workflowInputs: BUILTIN_WORKFLOW_INPUTS });
      return manifest.agents;
    },

    async listAgentSchedules(project: string): Promise<Array<{ id: string; scheduleSpec: string; workflow: string; paused: boolean; taskQueue?: string }>> {
      const client = deps.scheduleClient;
      if (!client || !client.list) return [];
      const out: Array<{ id: string; scheduleSpec: string; workflow: string; paused: boolean; taskQueue?: string }> = [];
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        for await (const s of client.list!()) {
          const rec = s as Record<string, unknown>;
          const sid = rec.scheduleId as string | undefined;
          if (!sid || !sid.startsWith(`agent:${project}:`)) continue;
          const spec = (rec.schedule as any)?.spec;
          const scheduleSpec = typeof spec === 'string' ? spec : ((spec as any)?.cron?.cronString ?? String(spec ?? ''));
          const workflow = (rec.action as any)?.workflowType ?? 'whiteboxBugHunt';
          const taskQueue = (rec.action as any)?.taskQueue as string | undefined;
          out.push({ id: sid, scheduleSpec, workflow, paused: false, taskQueue });
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      } catch {
        // best effort
      }
      return out;
    },

    async applyScheduleChanges(project: string, repo: string, plan: ReconcilePlan): Promise<void> {
      const client = deps.scheduleClient;
      if (!client) return;
      const tq = deps.taskQueue ?? ENGINE_QUEUE;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      for (const spec of [...plan.toCreate, ...plan.toUpdate]) {
        if (spec.schedule === 'continuous') continue;
        const id = scheduleId(project, spec.name);
        const args = [{ repo, project, ...spec.input }];
        const memo = { project, agentName: spec.name, workflowType: spec.workflow };
        const searchAttributes = { project: [project], agentName: [spec.name], workflowType: [spec.workflow] };
        if (plan.toCreate.some((c) => c.name === spec.name) && client.create) {
          await client.create({
            scheduleId: id,
            spec: { cron: { cronString: spec.schedule, timezone: spec.timezone } },
            action: { type: 'startWorkflow', workflowType: spec.workflow, args, taskQueue: tq, memo, searchAttributes },
            memo,
            searchAttributes,
          } as any);
        } else {
          const h = client.getHandle(id);
          await h.update?.({
            schedule: { spec: { cron: { cronString: spec.schedule, timezone: spec.timezone } }, action: { type: 'startWorkflow', workflowType: spec.workflow, args, taskQueue: tq, memo, searchAttributes } },
            memo,
            searchAttributes,
          } as any).catch(() => {});
        }
      }
      for (const id of plan.toPause) {
        await client.getHandle(id).pause?.().catch(() => {});
      }
      for (const id of plan.toResume) {
        await client.getHandle(id).unpause?.().catch(() => {});
      }
      for (const id of plan.toDelete) {
        await client.getHandle(id).delete?.().catch(() => {});
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    /* eslint-disable @typescript-eslint/no-explicit-any */
    async listContinuousAgents(project: string): Promise<string[]> {
      const client = deps.workflowClient;
      if (!client?.list) return [];
      const ids: string[] = [];
      const prefix = `agent:${project}:`;
      try {
        for await (const wf of client.list(`ExecutionStatus="Running"`)) {
          const id = (wf as any).workflowId as string | undefined;
          if (id && id.startsWith(prefix)) ids.push(id);
        }
      } catch { /* best effort */ }
      return ids;
    },
    async startContinuousAgent(project: string, repo: string, spec: AgentSpec): Promise<void> {
      const client = deps.workflowClient;
      if (!client?.start) return;
      const id = scheduleId(project, spec.name);
      const memo = { project, agentName: spec.name, workflowType: spec.workflow };
      try {
        await client.start(spec.workflow, {
          workflowId: id,
          taskQueue: (spec as any).taskQueue ?? ENGINE_QUEUE,
          args: [{ repo, project, ...spec.input }],
          memo,
          searchAttributes: { project: [project], agentName: [spec.name], workflowType: [spec.workflow] },
        });
      } catch (err) {
        if (!(err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError')) throw err;
      }
    },
    async terminateContinuousAgent(id: string): Promise<void> {
      await deps.workflowClient?.getHandle?.(id)?.terminate?.('agent removed from manifest').catch(() => {});
    },
    /* eslint-enable @typescript-eslint/no-explicit-any */

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

import type { EngineActivities } from '@agentops/contracts';
// Compile-time guarantee: the engine's activity implementation stays a
// superset of the published EngineActivities surface. If a signature drifts,
// typecheck fails here. SP2 design §3.2.
type _Acts = ReturnType<typeof createActivities>;
type _AssertEngineSurface = _Acts extends EngineActivities ? true : false;
const _engineSurfaceOk: _AssertEngineSurface = true;
void _engineSurfaceOk;
