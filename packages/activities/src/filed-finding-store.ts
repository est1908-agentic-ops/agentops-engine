export interface FiledFinding {
  project: string;
  fingerprint: string;
  issueRef: string;
}

export interface FiledFindingStore {
  reserve(project: string, fingerprint: string): Promise<{ won: boolean; issueRef: string }>;
  finalize(project: string, fingerprint: string, issueRef: string): Promise<void>;
  release(project: string, fingerprint: string): Promise<void>;
}

export class InMemoryFiledFindingStore implements FiledFindingStore {
  private readonly byKey = new Map<string, FiledFinding>();
  private key(p: string, fp: string) {
    return `${p}:${fp}`;
  }

  reserve(project: string, fingerprint: string): Promise<{ won: boolean; issueRef: string }> {
    const k = this.key(project, fingerprint);
    const existing = this.byKey.get(k);
    if (!existing) {
      this.byKey.set(k, { project, fingerprint, issueRef: '' });
      return Promise.resolve({ won: true, issueRef: '' });
    }
    if (existing.issueRef === '') {
      return Promise.resolve({ won: false, issueRef: '' });
    }
    return Promise.resolve({ won: false, issueRef: existing.issueRef });
  }

  finalize(project: string, fingerprint: string, issueRef: string): Promise<void> {
    const k = this.key(project, fingerprint);
    const existing = this.byKey.get(k);
    if (existing && existing.issueRef === '') {
      existing.issueRef = issueRef;
    }
    return Promise.resolve();
  }

  release(project: string, fingerprint: string): Promise<void> {
    const k = this.key(project, fingerprint);
    const existing = this.byKey.get(k);
    if (existing && existing.issueRef === '') {
      this.byKey.delete(k);
    }
    return Promise.resolve();
  }
}
