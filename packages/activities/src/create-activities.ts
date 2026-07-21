import { trace } from '@opentelemetry/api';
import {
  ProcessCliAuthError,
  RateLimitError,
  RateWindowExceededError,
  SessionLimitExhaustedError,
  TierFallbackBackend,
  type AgentBackend,
} from '@agentops/backends';
import {
  normalizeRepo,
  tryParseRef,
  type Issue,
  type OpenPrRequest,
  type OpenPrResult,
  type ScmPort,
  type TrackerPort,
} from '@agentops/ports';
import type {
  AgentRunRequest,
  AgentRunResult,
  ExecutePlatformActionRequest,
  ExecutePlatformActionResult,
  MergePrRequest,
  MergePrResult,
  ModelRef,
  PrFeedback,
  PrSnapshot,
  ProjectConfig,
  ResolvedProjectEntry,
  RunStats,
} from '@agentops/contracts';
import {
  MergePrResultSchema,
  parseProjectConfig,
  PrSnapshotSchema,
  sha256,
  type AgentSpec,
  type AgentsManifest,
} from '@agentops/contracts';
import type { FiledFindingStore } from './filed-finding-store';
import { cronScheduleSpec, type ScheduleClientLike } from './schedule-ops';
import { ENGINE_QUEUE } from '@agentops/contracts';
import type { ReconcilePlan } from '@agentops/policies';
import { orphanScheduleIds, resolveAgentQueue, resolveTier, scheduleId } from '@agentops/policies';
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
import { assertProjectOwnsRepo, getCallerProject } from './project-context';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
  registry: ResolvedProjectEntry[];
  // Global tier table loaded from Postgres (SP3-A). When omitted, resolveTier
  // falls back to DEFAULT_TIERS (the hardcoded seed) -- the in-memory/demo path.
  globalTiers?: Record<string, ModelRef[]>;
  filedFindings?: FiledFindingStore;
  scheduleClient?: ScheduleClientLike;
  taskQueue?: string;
  workflowClient?: WorkflowClientLike;
  heartbeat?: (details: unknown) => void;
}

export interface WorkflowClientLike {
  start?: (workflowType: string, opts: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  list?: (query?: string) => AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  getHandle?: (id: string) => {
    terminate?: (reason?: string) => Promise<void>;
    signal?: (signalName: string, ...args: unknown[]) => Promise<void>;
  };
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

// Fixed backoff for a self-clearing provider 429 (RateLimitError). The CLI
// doesn't reliably surface a Retry-After, so a fixed wait lets Temporal's
// activity retry absorb the cooldown. Chart/operator-tunable later (SP3).
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

export function createActivities(deps: ActivityDependencies) {
  const heartbeat = deps.heartbeat ?? ((details: unknown) => Context.current().heartbeat(details));
  return {
    async runAgent(
      req: AgentRunRequest,
    ): Promise<AgentRunResult & { promptHash: string; promptSource: string }> {
      // Resolve the model: either via a tier ref (the normal path -- the
      // workflow sends a tier name, the activity resolves it to an ordered
      // ModelRef[] whose [0] is the primary and the rest is the
      // session-limit fallback chain) or via a concrete backend+model
      // (the platform.ts fixed-model path, which sets no tier).
      let primaryBackend: AgentBackend;
      let primaryModelRef: ModelRef;
      let chain: ModelRef[];

      if (req.tier) {
        const entries = resolveTier(req.projectTiers, req.tier, req.effort, deps.globalTiers);
        primaryModelRef = entries[0];
        chain = entries.slice(1);
        primaryBackend = deps.backends[primaryModelRef.backend];
        if (!primaryBackend) {
          throw new Error(
            `createActivities.runAgent: unknown backend "${primaryModelRef.backend}" for tier "${req.tier}"`,
          );
        }
      } else {
        primaryBackend = deps.backends[req.backend!];
        if (!primaryBackend) {
          throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
        }
        // ModelRef.backend is a fixed enum, but the workflow's concrete-model
        // path may pass a backend name outside it (e.g. 'platform'). The cast
        // is safe: req.backend was set by a workflow that knows its registry.
        primaryModelRef = {
          backend: req.backend! as ModelRef['backend'],
          model: req.model!,
          effort: req.effort,
        };
        chain = [];
      }

      // The 'platform' backend carries a distinct, more-privileged K8s
      // ServiceAccount/secret (see buildBackends in worker/main.ts) than any
      // project-facing backend. A Tier-2 project workflow can freely name any
      // tier/backend in its own request (req.backend and req.projectTiers are
      // caller-supplied), so without this check a project could reach the
      // platform identity purely by asking for it. Absent caller project =>
      // engine-internal call (e.g. platform.ts itself) -- no restriction.
      // Checked against the whole resolved chain, not just the primary, since
      // a session-limit fallback could also resolve to 'platform'.
      if (getCallerProject() && [primaryModelRef, ...chain].some((m) => m.backend === 'platform')) {
        throw ApplicationFailure.nonRetryable(
          'project workflows may not route runAgent through the platform backend',
          'ProjectAuthorizationError',
        );
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
        backend: primaryModelRef.backend,
        model: primaryModelRef.model,
      });
      // Wrap with TierFallbackBackend only when there's a chain to walk (a
      // resolved tier with >1 entry). A concrete-model call or a single-entry
      // tier dispatches directly -- no fallback to attempt.
      const dispatchBackend =
        chain.length > 0
          ? new TierFallbackBackend(primaryBackend, deps.backends, chain, req.stage, heartbeat)
          : primaryBackend;
      try {
        const result = await dispatchBackend.run({
          taskId: req.taskId,
          stage: req.stage,
          attempt: req.attempt,
          callIndex: req.callIndex,
          backend: primaryModelRef.backend,
          model: primaryModelRef.model,
          effort: primaryModelRef.effort,
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
        // resolvedBackend/Model reflect whatever actually served the call:
        // TierFallbackBackend stamps the fallback's identity on a successful
        // cross-backend retry; the primary's identity otherwise.
        const resolvedBackend = result.resolvedBackend ?? primaryModelRef.backend;
        const resolvedModel = result.resolvedModel ?? primaryModelRef.model;
        trace.getActiveSpan()?.setAttributes({
          'gen_ai.system': resolvedBackend,
          'gen_ai.request.model': resolvedModel,
          'gen_ai.usage.input_tokens': result.tokensIn,
          'gen_ai.usage.output_tokens': result.tokensOut,
          'agentops.stage': req.stage,
          'agentops.attempt': req.attempt,
          'agentops.prompt.hash': promptHash,
          'agentops.prompt.source': promptSource,
        });
        return {
          ...result,
          resolvedBackend,
          resolvedModel,
          promptHash,
          promptSource,
        };
      } catch (err) {
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
        // The entire session-limit fallback chain is exhausted (every tier
        // entry hit an account-wide cap lasting hours). Fail fast, non-retryable:
        // burning Temporal's maximumAttempts budget re-hitting the same cap is
        // exactly the issue-broccoli-94 failure mode this design exists to fix.
        if (err instanceof SessionLimitExhaustedError) {
          throw ApplicationFailure.nonRetryable(err.message, 'SessionLimitExhaustedError');
        }
        // A self-clearing 429 (minutes). The TierFallbackBackend propagated
        // it untouched -- here we convert it to a retryable wait so Temporal's
        // own retry absorbs the cooldown without changing the model.
        if (err instanceof RateLimitError) {
          throw ApplicationFailure.create({
            message: err.message,
            type: 'RateLimitError',
            nonRetryable: false,
            nextRetryDelay: RATE_LIMIT_RETRY_DELAY_MS,
          });
        }
        throw err;
      }
    },
    async executePlatformAction(
      req: ExecutePlatformActionRequest,
    ): Promise<ExecutePlatformActionResult> {
      const handle = deps.workflowClient?.getHandle?.(req.workflowId);
      if (!handle) {
        return { ok: false, detail: 'no workflow client configured' };
      }
      try {
        if (req.type === 'terminate') {
          if (!handle.terminate) {
            return { ok: false, detail: 'terminate not supported by workflow client' };
          }
          await handle.terminate(req.reason);
          return { ok: true, detail: `terminated ${req.workflowId}` };
        }
        if (!req.signalName) {
          return { ok: false, detail: 'signalName is required for a signal action' };
        }
        if (!handle.signal) {
          return { ok: false, detail: 'signal not supported by workflow client' };
        }
        await handle.signal(req.signalName);
        return { ok: true, detail: `signalled ${req.workflowId} with "${req.signalName}"` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'action failed' };
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
    async unlabelIssue(ref: string, label: string): Promise<void> {
      await deps.tracker.removeLabel(ref, label);
    },
    async createIssue(req: {
      repo: string;
      project: string;
      title: string;
      body: string;
      labels: string[];
      dedupeFingerprint?: string;
    }): Promise<{ ref: string; url: string; deduped: boolean }> {
      assertProjectOwnsRepo(req.repo, deps.registry);
      const filedFindings = deps.filedFindings;
      if (req.dedupeFingerprint && filedFindings) {
        const existing = await filedFindings.find(req.project, req.dedupeFingerprint);
        if (existing) {
          await filedFindings.record({
            project: req.project,
            fingerprint: req.dedupeFingerprint,
            issueRef: existing.issueRef,
          });
          return { ref: existing.issueRef, url: '', deduped: true };
        }
      }
      const created = await deps.tracker.createIssue({
        repo: req.repo,
        title: req.title,
        body: req.body,
        labels: req.labels,
      });
      if (req.dedupeFingerprint && filedFindings) {
        await filedFindings.record({
          project: req.project,
          fingerprint: req.dedupeFingerprint,
          issueRef: created.ref,
        });
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
    async getPrSnapshot(prRef: string): Promise<PrSnapshot> {
      const parsed = tryParseRef(prRef);
      if (parsed) assertProjectOwnsRepo(`${parsed.owner}/${parsed.repo}`, deps.registry);
      const snapshot = await deps.scm.getPrSnapshot(prRef);
      return PrSnapshotSchema.parse(snapshot);
    },
    async mergePr(req: MergePrRequest): Promise<MergePrResult> {
      const parsed = tryParseRef(req.prRef);
      if (parsed) assertProjectOwnsRepo(`${parsed.owner}/${parsed.repo}`, deps.registry);
      const result = await deps.scm.mergePr(req);
      return MergePrResultSchema.parse(result);
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
      headBranch?: string;
      headRef?: string;
    }): Promise<PreparedWorkspace> {
      assertProjectOwnsRepo(req.repo, deps.registry);
      try {
        return await deps.workspaces.prepare(
          req.taskId,
          req.repo,
          req.initCommands,
          req.headBranch,
          req.headRef,
        );
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
    async readWorkspaceFile(workspaceRef: string, relativePath: string): Promise<string | null> {
      return deps.workspaces.readFile(workspaceRef, relativePath);
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

    async listManagedProjects(): Promise<Array<{ project: string; repo: string }>> {
      return deps.registry.map((e) => ({ project: e.project, repo: e.repo }));
    },

    async pruneOrphanWorkspaces(liveRepos: string[]): Promise<{ removed: string[] }> {
      return deps.workspaces.pruneOrphans(liveRepos);
    },

    async loadAgentsManifest(project: string, repo: string): Promise<AgentsManifest> {
      // Agents + worker are the corresponding blocks of the project's
      // agentops.json (validated by parseProjectConfig). A missing file yields
      // full defaults, i.e. no agents and no worker.
      const config = await loadProjectConfig(deps.scm, repo);
      return { agents: config.agents ?? [], worker: config.worker };
    },

    async listAgentSchedules(
      project: string,
    ): Promise<
      Array<{
        id: string;
        scheduleSpec: string;
        workflow: string;
        paused: boolean;
        taskQueue?: string;
      }>
    > {
      const client = deps.scheduleClient;
      if (!client || !client.list) return [];
      const out: Array<{
        id: string;
        scheduleSpec: string;
        workflow: string;
        paused: boolean;
        taskQueue?: string;
      }> = [];
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        for await (const s of client.list!()) {
          const rec = s as Record<string, unknown>;
          const sid = rec.scheduleId as string | undefined;
          if (!sid || !sid.startsWith(`agent:${project}:`)) continue;
          const spec = (rec.schedule as any)?.spec;
          const scheduleSpec =
            typeof spec === 'string'
              ? spec
              : ((spec as any)?.cronExpressions?.[0] ??
                (spec as any)?.cron?.cronString ??
                String(spec ?? ''));
          let workflow = (rec.action as any)?.workflowType ?? 'whiteboxBugHunt';
          let taskQueue: string | undefined;
          // Fetch the real task queue and workflow from the schedule description.
          // The list() summary does not include taskQueue; describe() returns the full object.
          try {
            const desc = await client.getHandle!(sid).describe?.();
            if (desc) {
              taskQueue = (desc as any)?.action?.taskQueue;
              const descWorkflow = (desc as any)?.action?.workflowType;
              if (descWorkflow) workflow = descWorkflow;
            }
          } catch {
            // describe() failed; taskQueue remains undefined, workflow from summary
          }
          out.push({ id: sid, scheduleSpec, workflow, paused: false, taskQueue });
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      } catch {
        // best effort
      }
      return out;
    },

    async pruneOrphanAgentSchedules(liveProjects: string[]): Promise<{ deleted: string[] }> {
      const client = deps.scheduleClient;
      if (!client || !client.list) return { deleted: [] };
      const ids: string[] = [];
      try {
        for await (const s of client.list!()) {
          const sid = (s as Record<string, unknown>).scheduleId as string | undefined;
          if (sid && sid.startsWith('agent:')) ids.push(sid);
        }
      } catch {
        // Can't enumerate schedules right now -- skip this sweep; the next
        // reconcile (~15 min) retries. Never delete on a partial/failed list.
        return { deleted: [] };
      }
      const orphans = orphanScheduleIds(ids, liveProjects);
      const deleted: string[] = [];
      for (const id of orphans) {
        try {
          await client.getHandle(id).delete?.();
          deleted.push(id);
        } catch {
          // Best-effort; a transient delete failure is retried next sweep.
        }
      }
      return { deleted };
    },

    async applyScheduleChanges(project: string, repo: string, plan: ReconcilePlan): Promise<void> {
      const client = deps.scheduleClient;
      if (!client) return;
      for (const spec of [...plan.toCreate, ...plan.toUpdate]) {
        if (spec.schedule === 'continuous') continue;
        const actionQueue = resolveAgentQueue(spec, project, deps.taskQueue ?? ENGINE_QUEUE);
        const id = scheduleId(project, spec.name);
        const args = [{ repo, project, ...spec.input }];
        const memo = { project, agentName: spec.name, workflowType: spec.workflow };
        const searchAttributes = {
          project: [project],
          agentName: [spec.name],
          workflowType: [spec.workflow],
        };
        if (plan.toCreate.some((c) => c.name === spec.name) && client.create) {
          await client.create({
            scheduleId: id,
            spec: cronScheduleSpec(spec.schedule, spec.timezone),
            action: {
              type: 'startWorkflow',
              workflowType: spec.workflow,
              args,
              taskQueue: actionQueue,
              memo,
              searchAttributes,
            },
            memo,
            searchAttributes,
          });
        } else {
          const h = client.getHandle(id);
          // The real ScheduleHandle.update() (unlike .create()) takes an updater
          // function -- (previous) => newSchedule -- not a plain options object.
          // deps.scheduleClient is `tc.schedule as unknown as ScheduleClientLike`
          // (see worker/src/main.ts:453), so the updater must return a flat
          // ScheduleUpdateOpts object (action, spec, memo, searchAttributes — no
          // nested schedule wrapper). The updater is best-effort; a single schedule's
          // update failure is caught and doesn't abort the reconcile sweep.
          await h
            .update?.(() => ({
              action: {
                type: 'startWorkflow',
                workflowType: spec.workflow,
                args,
                taskQueue: actionQueue,
                memo,
                searchAttributes,
              },
              spec: cronScheduleSpec(spec.schedule, spec.timezone),
              memo,
              searchAttributes,
            }))
            ?.catch(() => {});
        }
      }
      for (const id of plan.toPause) {
        await client
          .getHandle(id)
          .pause?.()
          .catch(() => {});
      }
      for (const id of plan.toResume) {
        await client
          .getHandle(id)
          .unpause?.()
          .catch(() => {});
      }
      for (const id of plan.toDelete) {
        await client
          .getHandle(id)
          .delete?.()
          .catch(() => {});
      }
    },
    /* eslint-disable @typescript-eslint/no-explicit-any */
    async listContinuousAgents(project: string): Promise<string[]> {
      const client = deps.workflowClient;
      if (!client?.list) return [];
      const ids: string[] = [];
      try {
        for await (const wf of client.list(`ExecutionStatus="Running"`)) {
          const id = (wf as any).workflowId as string | undefined;
          const agentName = (wf as any).searchAttributes?.agentName?.[0] as string | undefined;
          // A Temporal Schedule fires workflows as `<scheduleId>-workflow-<timestamp>`,
          // which shares the `agent:<project>:` id prefix with a genuine continuous
          // singleton (started at the bare `agent:<project>:<name>` id, no suffix).
          // Matching on prefix alone sweeps up an in-flight *scheduled* run and gets
          // it terminated as an "orphaned continuous agent" -- require an exact match
          // against the deterministic singleton id instead.
          if (id && agentName && id === scheduleId(project, agentName)) ids.push(id);
        }
      } catch {
        /* best effort */
      }
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
          taskQueue: resolveAgentQueue(spec, project),
          args: [{ repo, project, ...spec.input }],
          memo,
          searchAttributes: {
            project: [project],
            agentName: [spec.name],
            workflowType: [spec.workflow],
          },
        });
      } catch (err) {
        if (!(err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError'))
          throw err;
      }
    },
    async terminateContinuousAgent(id: string): Promise<void> {
      await deps.workflowClient
        ?.getHandle?.(id)
        ?.terminate?.('agent removed from manifest')
        .catch(() => {});
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
