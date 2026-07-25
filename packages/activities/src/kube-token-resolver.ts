import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

const TOKEN_KEY = 'GITHUB_TOKEN';

/**
 * Resolves a project's GitHub token by reading a Kubernetes Secret by name
 * at request time -- one Secret per project (`tokenSecret` on the managed
 * project's `project.yaml`), not a single shared `GITHUB_TOKEN` env var (that
 * design was superseded; see resolve-managed-projects.ts's
 * `ManagedProjectRegistryDeps.resolveToken`).
 *
 * Caches by Secret name for the process lifetime: a token doesn't rotate
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

  async get(secretName: string): Promise<string> {
    const cached = this.cache.get(secretName);
    if (cached !== undefined) {
      return cached;
    }

    const secret = await this.api.readNamespacedSecret({ name: secretName, namespace: this.namespace });
    const encoded = secret.data?.[TOKEN_KEY];
    if (!encoded) {
      throw new Error(
        `KubeTokenResolver: Secret "${secretName}" in namespace "${this.namespace}" has no "${TOKEN_KEY}" key`,
      );
    }

    const token = Buffer.from(encoded, 'base64').toString('utf8');
    this.cache.set(secretName, token);
    return token;
  }
}
