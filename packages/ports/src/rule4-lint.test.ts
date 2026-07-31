import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

describe('AGENTS.md rule 4: Forge/tracker SDK ban', () => {
  let eslint: ESLint;

  const repoRoot = process.cwd();

  beforeAll(async () => {
    eslint = new ESLint({ cwd: repoRoot });
  });

  it('should reject @octokit/rest imports outside packages/ports', async () => {
    const code = `import { Octokit } from '@octokit/rest';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/activities/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 4');
  }, 30_000);

  it('should reject @octokit/rest imports in packages/gateway', async () => {
    const code = `import { Octokit } from '@octokit/rest';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/gateway/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 4');
  }, 30_000);

  it('should allow @octokit/rest imports inside packages/ports', async () => {
    const code = `import { Octokit } from '@octokit/rest';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/ports/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(0);
  }, 30_000);

  it('should reject @octokit/graphql imports via patterns', async () => {
    const code = `import { graphql } from '@octokit/graphql';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/activities/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 4');
  }, 30_000);

  it('should reject @gitbeaker/* imports via patterns', async () => {
    const code = `import { Gitlab } from '@gitbeaker/rest';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/activities/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 4');
  }, 30_000);

  it('should allow @agentops/ports imports (false-positive guard)', async () => {
    const code = `import { buildGithubPorts } from '@agentops/ports';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/gateway/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(0);
  }, 30_000);

  it('should reject @octokit/rest imports in packages/workflows (rule 4 not lost)', async () => {
    const code = `import { Octokit } from '@octokit/rest';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 4');
  }, 30_000);

  it('should still reject axios imports in packages/workflows (rule 1 not clobbered)', async () => {
    const code = `import axios from 'axios';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 1');
  }, 30_000);

  it('should reject @octokit/rest imports in packages/workflows test files', async () => {
    const code = `import { Octokit } from '@octokit/rest';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.test.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 4');
  }, 30_000);
});
