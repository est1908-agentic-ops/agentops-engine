import { describe, it, expect } from 'vitest';
import { isValidGitRefName, GitRefNameSchema } from './git-ref';

describe('git-ref validation', () => {
  function assertCongruent(name: string, expectedValid: boolean): void {
    const predicateResult = isValidGitRefName(name);
    const schemaResult = GitRefNameSchema.safeParse(name).success;
    expect(predicateResult).toBe(expectedValid);
    expect(schemaResult).toBe(expectedValid);
  }

  describe('accepts valid branches', () => {
    it('accepts simple branch names', () => {
      assertCongruent('main', true);
      assertCongruent('develop', true);
      assertCongruent('feature/x', true);
      assertCongruent('release-1.2', true);
      assertCongruent('user.name/fix', true);
      assertCongruent('dependabot/npm_and_yarn/foo-1.2.3', true);
    });

    it('accepts non-ASCII branch names', () => {
      assertCongruent('feature/café', true);
      assertCongruent('bugfix/тест', true);
    });

    it('accepts branches with underscores, hyphens, dots', () => {
      assertCongruent('feature_branch', true);
      assertCongruent('release-2.0', true);
      assertCongruent('user.name', true);
      assertCongruent('v1.2.3', true);
    });

    it('accepts branches with multiple slashes', () => {
      assertCongruent('feature/user/branch', true);
      assertCongruent('team/project/feature', true);
    });
  });

  describe('rejects attack/edge cases', () => {
    it('rejects leading dash (critical: option injection)', () => {
      assertCongruent('--upload-pack=/tmp/x', false);
      assertCongruent('-x', false);
      assertCongruent('--exec=malicious', false);
      assertCongruent('--help', false);
    });

    it('rejects space', () => {
      assertCongruent('a b', false);
      assertCongruent('feature branch', false);
      assertCongruent(' leading', false);
    });

    it('rejects control characters', () => {
      assertCongruent('feature\x00null', false);
      assertCongruent('feature\nwith\nnewline', false);
      assertCongruent('feature\twith\ttab', false);
      assertCongruent('feature\x1funit-sep', false);
    });

    it('rejects DEL character', () => {
      assertCongruent('feature\x7fdel', false);
    });

    it('rejects git-forbidden metacharacters', () => {
      assertCongruent('feature~base', false);
      assertCongruent('feature^parent', false);
      assertCongruent('feature:part', false);
      assertCongruent('feature?what', false);
      assertCongruent('feature*glob', false);
      assertCongruent('feature[bracket', false);
      assertCongruent('feature\\backslash', false);
    });

    it('rejects double-dot', () => {
      assertCongruent('a..b', false);
      assertCongruent('feature...branch', false);
    });

    it('rejects @{ (reflog syntax)', () => {
      assertCongruent('feature@{0}', false);
      assertCongruent('branch@{-1}', false);
    });

    it('rejects lone @', () => {
      assertCongruent('@', false);
    });

    it('rejects leading slash', () => {
      assertCongruent('/feature', false);
    });

    it('rejects trailing slash', () => {
      assertCongruent('feature/', false);
      assertCongruent('feature/branch/', false);
    });

    it('rejects empty path component (double slash)', () => {
      assertCongruent('a//b', false);
      assertCongruent('feature//branch', false);
    });

    it('rejects components starting with dot', () => {
      assertCongruent('.hidden', false);
      assertCongruent('feature/.bar', false);
      assertCongruent('.feature/branch', false);
    });

    it('rejects trailing dot', () => {
      assertCongruent('foo.', false);
      assertCongruent('feature.', false);
    });

    it('rejects trailing .lock or component ending in .lock', () => {
      assertCongruent('foo.lock', false);
      assertCongruent('feature.lock', false);
      assertCongruent('feature/branch.lock', false);
    });

    it('rejects empty string', () => {
      assertCongruent('', false);
    });
  });

  describe('schema error messages', () => {
    it('provides helpful error message on validation failure', () => {
      const result = GitRefNameSchema.safeParse('--upload-pack=x');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid git ref name');
      }
    });
  });
});
