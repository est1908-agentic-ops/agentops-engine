import { Context } from '@temporalio/activity';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { ProviderRateLimitedError } from '../provider-rate-limit';

// Wraps a subscription-lane backend (pi) to retry once against a known-good
// fallback model on the same backend when the provider itself throttles a
// call (ProviderRateLimitedError) -- distinct from RateWindowedBackend, which
// throws *before* ever calling the inner backend based on a locally-tracked
// quota. Only reacts to a real provider response, and only retries once: if
// the fallback also fails, the error propagates untouched into the same
// generic retry path every other backend error already takes in
// create-activities.ts (Temporal's own maximumAttempts + backoff on
// agentActivities), so there's no new bookkeeping for "how many times have
// we tried." See
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
export class RateLimitFallbackBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,
    private readonly fallbackModel: string,
    private readonly backendName: string,
    private readonly heartbeat: (details: unknown) => void = (details) => Context.current().heartbeat(details),
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    try {
      return await this.inner.run(req);
    } catch (err) {
      if (!(err instanceof ProviderRateLimitedError)) {
        throw err;
      }
      const details = {
        event: 'provider-rate-limited',
        backend: this.backendName,
        taskId: req.taskId,
        stage: req.stage,
        primaryModel: req.model,
        fallbackModel: this.fallbackModel,
        message: err.message,
      };
      this.heartbeat(details);
      // Heartbeat/pending-activity detail is ephemeral -- gone once the
      // workflow closes. This line survives in Loki via the existing stdout
      // pipeline, matching how every other worker log is captured today.
      console.warn(JSON.stringify(details));
      return this.inner.run({ ...req, model: this.fallbackModel });
    }
  }
}
