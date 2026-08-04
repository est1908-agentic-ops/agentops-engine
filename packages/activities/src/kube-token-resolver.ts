import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

/**
 * Resolves a credential by reading an explicit key from a Kubernetes Secret
 * at request time. Managed-project fields select the provider-specific key;
 * the Secret name and key are both part of the credential identity.
 *
 * Caches by Secret name and key for the process lifetime: a token doesn't rotate
 * more often than a pod restart cadence in this design, and re-reading the
 * Secret on every webhook/task-start would mean one K8s API round-trip per
 * call. `api` is injectable so tests can supply a fake instead of hitting a
 * real cluster; the real constructor path loads in-cluster config the same
 * way `packages/worker/src/main.ts` does for `BatchV1Api`.
 */
export class KubeTokenResolver {
  private readonly api: CoreV1Api;
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly namespace: string,
    api?: CoreV1Api,
  ) {
    if (api) {
      this.api = api;
    } else {
      const kc = new KubeConfig();
      kc.loadFromCluster();
      this.api = kc.makeApiClient(CoreV1Api);
    }
  }

  async get(secretName: string, key: string): Promise<string> {
    const cacheKey = `${secretName}\0${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let secret;
    try {
      secret = await this.api.readNamespacedSecret({ name: secretName, namespace: this.namespace });
    } catch (error) {
      throw new Error(
        `KubeTokenResolver: failed to read Secret "${secretName}" in namespace "${this.namespace}" for key "${key}"`,
        { cause: error },
      );
    }
    const encoded = secret.data?.[key];
    if (!encoded) {
      throw new Error(
        `KubeTokenResolver: Secret "${secretName}" in namespace "${this.namespace}" has no "${key}" key`,
      );
    }

    const token = Buffer.from(encoded, 'base64').toString('utf8');
    this.cache.set(cacheKey, token);
    return token;
  }
}
