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

    const token = await resolver.get('github-token-acme', 'GITHUB_TOKEN');

    expect(token).toBe('ghp_secret');
    expect(api.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'github-token-acme',
      namespace: 'dev-agents',
    });
  });

  it('reads and base64-decodes the requested Linear token key', async () => {
    const api = fakeApi({
      'linear-token-acme': { LINEAR_API_TOKEN: Buffer.from('lin_secret').toString('base64') },
    });
    const resolver = new KubeTokenResolver('dev-agents', api);

    const token = await resolver.get('linear-token-acme', 'LINEAR_API_TOKEN');

    expect(token).toBe('lin_secret');
  });

  it('caches by secret name and key', async () => {
    const api = fakeApi({
      'project-tokens': {
        GITHUB_TOKEN: Buffer.from('ghp_secret').toString('base64'),
        LINEAR_API_TOKEN: Buffer.from('lin_secret').toString('base64'),
      },
    });
    const resolver = new KubeTokenResolver('dev-agents', api);

    const github = await resolver.get('project-tokens', 'GITHUB_TOKEN');
    const linear = await resolver.get('project-tokens', 'LINEAR_API_TOKEN');
    const githubAgain = await resolver.get('project-tokens', 'GITHUB_TOKEN');

    expect(github).toBe('ghp_secret');
    expect(linear).toBe('lin_secret');
    expect(githubAgain).toBe('ghp_secret');
    expect(api.readNamespacedSecret).toHaveBeenCalledTimes(2);
  });

  it('throws naming the secret and requested key when that key is missing', async () => {
    const api = fakeApi({ 'linear-token-broken': { SOME_OTHER_KEY: 'x' } });
    const resolver = new KubeTokenResolver('dev-agents', api);

    await expect(resolver.get('linear-token-broken', 'LINEAR_API_TOKEN')).rejects.toThrow(
      /linear-token-broken.*LINEAR_API_TOKEN/s,
    );
  });

  it('wraps Kubernetes read errors with the secret, namespace, and requested key', async () => {
    const resolver = new KubeTokenResolver('dev-agents', fakeApi({}));

    await expect(resolver.get('missing-linear-token', 'LINEAR_API_TOKEN')).rejects.toThrow(
      /missing-linear-token.*dev-agents.*LINEAR_API_TOKEN/s,
    );
  });
});
