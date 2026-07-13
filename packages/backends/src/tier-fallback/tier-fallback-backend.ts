import type { AgentRunResult, BackendRunRequest, ModelRef } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { RateLimitError, SessionLimitError, SessionLimitExhaustedError } from '../provider-rate-limit';

// Per-call cross-backend fallback decorator. Holds the full backend registry
// (so a fallback can dispatch to a DIFFERENT backend instance, escaping the
// credential domain that hit the session limit) and the resolved tier chain
// (the primary's sibling entries, minus the primary itself). On
// SessionLimitError it walks the chain; on RateLimitError it lets the error
// propagate (the activity maps it to a retryable wait); on exhaustion it
// throws SessionLimitExhaustedError (non-retryable). See
// docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md (Section 3).
export class TierFallbackBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,
    private readonly registry: Record<string, AgentBackend>,
    private readonly chain: ModelRef[],
    private readonly stage: string,
    private readonly heartbeat: (details: unknown) => void,
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    try {
      return await this.inner.run(req);
    } catch (err) {
      // RateLimit: propagate. The activity catch maps this to a retryable
      // ApplicationFailure with nextRetryDelay (wait it out, no model change).
      if (err instanceof RateLimitError) throw err;

      if (!(err instanceof SessionLimitError)) throw err;

      for (const fallback of this.chain) {
        const details = {
          event: 'session-limit-fallback',
          stage: this.stage,
          taskId: req.taskId,
          from: { backend: req.backend, model: req.model },
          to: { backend: fallback.backend, model: fallback.model, effort: fallback.effort },
        };
        this.heartbeat(details);
        console.warn(JSON.stringify(details));
        try {
          return await this.registry[fallback.backend].run({
            ...req,
            backend: fallback.backend,
            model: fallback.model,
            effort: fallback.effort ?? req.effort,
          }).then((res) => ({
            ...res,
            // Stamp which backend/model actually served this call so stats /
            // traces attribute to the fallback, not the throttled primary.
            resolvedBackend: fallback.backend,
            resolvedModel: fallback.model,
          }));
        } catch (e) {
          if (e instanceof SessionLimitError) continue;
          throw e;
        }
      }
      throw new SessionLimitExhaustedError(
        `all fallback tiers exhausted for stage "${this.stage}" (session limit)`,
      );
    }
  }
}
