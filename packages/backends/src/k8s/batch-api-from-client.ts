import type { BatchV1Api } from '@kubernetes/client-node';
import type { BatchV1ApiLike } from './fake-batch-api';
import type { V1Job } from './k8s-types';

export function batchApiFromClient(api: BatchV1Api): BatchV1ApiLike {
  return {
    async createNamespacedJob(namespace: string, body: V1Job): Promise<{ body: V1Job }> {
      const response = await api.createNamespacedJob({ namespace, body: body as never });
      return { body: response as V1Job };
    },
    async readNamespacedJobStatus(name: string, namespace: string): Promise<{ body: V1Job }> {
      const response = await api.readNamespacedJobStatus({ name, namespace });
      return { body: response as V1Job };
    },
    async deleteNamespacedJob(
      name: string,
      namespace: string,
      opts?: { propagationPolicy?: string },
    ): Promise<void> {
      await api.deleteNamespacedJob({
        name,
        namespace,
        propagationPolicy: opts?.propagationPolicy,
      });
    },
  };
}
