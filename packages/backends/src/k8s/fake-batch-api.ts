import { ApiException } from '@kubernetes/client-node';
import type { V1Job } from './k8s-types';

export interface BatchV1ApiLike {
  createNamespacedJob(namespace: string, body: V1Job): Promise<{ body: V1Job }>;
  readNamespacedJobStatus(name: string, namespace: string): Promise<{ body: V1Job }>;
  deleteNamespacedJob(
    name: string,
    namespace: string,
    opts?: { propagationPolicy?: string },
  ): Promise<void>;
}

export class FakeBatchApi implements BatchV1ApiLike {
  readonly creates: V1Job[] = [];
  readonly deletes: { name: string; namespace: string; opts?: { propagationPolicy?: string } }[] = [];
  private readonly jobs = new Map<string, V1Job>();

  async createNamespacedJob(namespace: string, body: V1Job): Promise<{ body: V1Job }> {
    const name = body.metadata?.name;
    if (!name) throw new Error('job metadata.name is required');
    if (this.jobs.has(name)) {
      throw new ApiException(409, 'Conflict', { message: `jobs.batch "${name}" already exists` }, {});
    }
    this.creates.push(body);
    const stored: V1Job = {
      ...body,
      metadata: { ...body.metadata, namespace },
      status: { active: 1 },
    };
    this.jobs.set(name, stored);
    return { body: stored };
  }

  async readNamespacedJobStatus(name: string, _namespace: string): Promise<{ body: V1Job }> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`job not found: ${name}`);
    return { body: job };
  }

  setJobStatus(name: string, status: NonNullable<V1Job['status']>): void {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`job not found: ${name}`);
    job.status = status;
  }

  async deleteNamespacedJob(
    name: string,
    namespace: string,
    opts?: { propagationPolicy?: string },
  ): Promise<void> {
    this.deletes.push({ name, namespace, opts });
    this.jobs.delete(name);
  }
}
