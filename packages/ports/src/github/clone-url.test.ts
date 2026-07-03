import { describe, expect, it } from 'vitest';
import { githubCloneUrl } from './clone-url';

describe('githubCloneUrl', () => {
  it('builds an HTTPS clone URL from an owner/repo slug', () => {
    expect(githubCloneUrl('octocat/hello-world')).toBe('https://github.com/octocat/hello-world.git');
  });
});
