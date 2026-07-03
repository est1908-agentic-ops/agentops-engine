import type { StageResult } from '@agentops/contracts';

export interface StageResultRecord extends StageResult {
  taskId: string;
}

export interface StageResultStore {
  record(result: StageResultRecord): void;
  forTask(taskId: string): StageResultRecord[];
}

export class InMemoryStageResultStore implements StageResultStore {
  private readonly entries: StageResultRecord[] = [];

  record(result: StageResultRecord): void {
    this.entries.push(result);
  }

  forTask(taskId: string): StageResultRecord[] {
    return this.entries.filter((entry) => entry.taskId === taskId);
  }
}
