import { describe, expect, it, vi } from 'vitest';
import type { CoreV1Api } from '@kubernetes/client-node';
import { KubeTokenResolver } from './kube-token-resolver';

function fakeApi(secrets: Record<string, Record<string, string> | undefined>): CoreV1Api {
  return {
    readNamespacedSecret: vi.fn(async ({ name }: { name: string; namespace: string }) => {
      const data = secrets[name];
      if (!data) {
        throw new Error(`no such secret: ${name}`);
      }
      return { data };
    }),
  } as unknown as CoreV1Api;
}

describe('KubeTokenResolver', () => {
  it('reads and base64-decodes the GITHUB_TOKEN key from the named Secret', async () => {
    const api = fakeApi({
      'github-token-acme': { GITHUB_TOKEN: Buffer.from('ghp_secret').toString('base64') },
    });
    const resolver = new KubeTokenResolver('dev-agents', api);

    const token = await resolver.get('github-token-acme');

    expect(token).toBe('ghp_secret');
    expect(api.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'github-token-acme',
      namespace: 'dev-agents',
    });
  });

  it('caches by secret name -- a second get() for the same name does not call the API again', async () => {
    const api = fakeApi({
      'github-token-acme': { GITHUB_TOKEN: Buffer.from('ghp_secret').toString('base64') },
    });
    const resolver = new KubeTokenResolver('dev-agents', api);

    const first = await resolver.get('github-token-acme');
    const second = await resolver.get('github-token-acme');

    expect(first).toBe('ghp_secret');
    expect(second).toBe('ghp_secret');
    expect(api.readNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it('throws naming the secret when the GITHUB_TOKEN key is missing', async () => {
    const api = fakeApi({ 'github-token-broken': { SOME_OTHER_KEY: 'x' } });
    const resolver = new KubeTokenResolver('dev-agents', api);

    await expect(resolver.get('github-token-broken')).rejects.toThrow(
      /github-token-broken.*GITHUB_TOKEN/s,
    );
  });
});
