import type { RunStats } from '@agentops/contracts';

export interface StatsStore {
  record(stats: RunStats): Promise<void>;
  all(): Promise<RunStats[]>;
}

export class InMemoryStatsStore implements StatsStore {
  private readonly entries: RunStats[] = [];

  async record(stats: RunStats): Promise<void> {
    this.entries.push(stats);
  }

  async all(): Promise<RunStats[]> {
    return [...this.entries];
  }
}
