import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import type { RateWindowLimiter } from './rate-window-limiter';

export class RateWindowExceededError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

// Wraps a subscription-lane backend (claude, pi) to respect a provider's
// prompts-per-window quota (ARCHITECTURE.md §5.5/§9) -- a scheduling input,
// not a human-facing brake, so it never surfaces as a blocked workflow state;
// create-activities.ts converts RateWindowExceededError into a *retryable*
// ApplicationFailure with nextRetryDelay set to retryAfterMs, letting
// Temporal's own activity retry wait out the window transparently.
export class RateWindowedBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,
    private readonly limiter: RateWindowLimiter,
    private readonly backendName: string,
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const wait = this.limiter.msUntilSlot();
    if (wait > 0) {
      throw new RateWindowExceededError(
        `${this.backendName} subscription rate window exhausted, retry in ${wait}ms`,
        wait,
      );
    }
    this.limiter.recordCall();
    return this.inner.run(req);
  }
}
