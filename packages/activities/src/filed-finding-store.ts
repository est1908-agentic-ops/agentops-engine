export interface FiledFinding {
  project: string;
  fingerprint: string;
  issueRef: string;
}

export interface FiledFindingStore {
  find(project: string, fingerprint: string): Promise<FiledFinding | null>;
  record(f: FiledFinding): Promise<void>;
}

export class InMemoryFiledFindingStore implements FiledFindingStore {
  private readonly byKey = new Map<string, FiledFinding>();
  private key(p: string, fp: string) {
    return `${p}:${fp}`;
  }
  async find(project: string, fingerprint: string) {
    return this.byKey.get(this.key(project, fingerprint)) ?? null;
  }
  async record(f: FiledFinding) {
    this.byKey.set(this.key(f.project, f.fingerprint), f);
  }
}
