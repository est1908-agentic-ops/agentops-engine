import { describe, expect, it } from 'vitest';
import { slugifyProject } from './slug';

describe('slugifyProject', () => {
  it('leaves an already slug-safe name unchanged', () => {
    expect(slugifyProject('my-project')).toBe('my-project');
  });

  it('turns spaces and mixed case into a git-branch-safe slug', () => {
    // Regression: "Artem private agents" produced the invalid branch
    // `agentops/issue-Artem private agents-1`.
    expect(slugifyProject('Artem private agents')).toBe('artem-private-agents');
  });

  it('collapses runs of punctuation and trims leading/trailing dashes', () => {
    expect(slugifyProject('  Foo / Bar (baz)!  ')).toBe('foo-bar-baz');
  });

  it('produces a valid git branch name (no spaces or ref-illegal chars)', () => {
    const slug = slugifyProject('Artem private agents');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(`agentops/issue-${slug}-1`).toBe('agentops/issue-artem-private-agents-1');
  });
});
