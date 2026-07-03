import type { RunStats } from '@agentops/contracts';

export interface StatsStore {
  record(stats: RunStats): void;
  all(): RunStats[];
}

export class InMemoryStatsStore implements StatsStore {
  private readonly entries: RunStats[] = [];

  record(stats: RunStats): void {
    this.entries.push(stats);
  }

  all(): RunStats[] {
    return [...this.entries];
  }
}
