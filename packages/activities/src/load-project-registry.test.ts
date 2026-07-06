import { describe, expect, it } from 'vitest';
import { loadProjectRegistry } from './load-project-registry';

describe('loadProjectRegistry', () => {
  it('returns an empty array when PROJECT_REGISTRY_JSON is unset', () => {
    expect(loadProjectRegistry({})).toEqual([]);
  });

  it("resolves each entry's token from its tokenEnvVar", () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
      ]),
      GITHUB_TOKEN__PRODUCT_A: 'ghp_fake',
    };

    expect(loadProjectRegistry(env)).toEqual([
      {
        product: 'product-a',
        repo: 'flair-hr/product-a',
        trackerType: 'github',
        tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A',
        token: 'ghp_fake',
      },
    ]);
  });

  it('throws naming the product and env var when a referenced tokenEnvVar is missing', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
      ]),
    };

    expect(() => loadProjectRegistry(env)).toThrow(/"GITHUB_TOKEN__PRODUCT_A".*"product-a"/);
  });

  it('throws on a malformed PROJECT_REGISTRY_JSON', () => {
    expect(() => loadProjectRegistry({ PROJECT_REGISTRY_JSON: '{}' })).toThrow();
  });

  it('resolves multiple entries independently', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
        { product: 'product-b', repo: 'flair-hr/product-b', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_B' },
      ]),
      GITHUB_TOKEN__PRODUCT_A: 'token-a',
      GITHUB_TOKEN__PRODUCT_B: 'token-b',
    };

    const resolved = loadProjectRegistry(env);

    expect(resolved.map((entry) => entry.token)).toEqual(['token-a', 'token-b']);
  });
});
