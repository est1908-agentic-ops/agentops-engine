export interface RateWindowConfig {
  maxCalls: number;
  windowMs: number;
}

// Pure sliding-window counter -- no Temporal/IO knowledge, so RateWindowedBackend
// (or a unit test) can drive it with an injectable clock. In-memory and
// per-instance: correct for today's single worker-process deployment; if the
// worker ever scales to multiple replicas, each replica gets its own window
// and the effective quota multiplies by replica count -- a named limitation,
// not addressed here (would need a shared store, e.g. Redis/Postgres).
export class RateWindowLimiter {
  private readonly callTimestamps: number[] = [];

  constructor(
    private readonly config: RateWindowConfig,
    private readonly now: () => number = Date.now,
  ) {}

  msUntilSlot(): number {
    this.prune();
    if (this.callTimestamps.length < this.config.maxCalls) {
      return 0;
    }
    const oldest = this.callTimestamps[0];
    return Math.max(0, oldest + this.config.windowMs - this.now());
  }

  recordCall(): void {
    this.prune();
    this.callTimestamps.push(this.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.config.windowMs;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] <= cutoff) {
      this.callTimestamps.shift();
    }
  }
}
