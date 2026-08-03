import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

describe('Determinism lint rules', () => {
  let eslint: ESLint;

  // Resolve repo root from process.cwd() (runs from repo root when invoked via pnpm test)
  const repoRoot = process.cwd();

  beforeAll(async () => {
    eslint = new ESLint({ cwd: repoRoot });
  });

  it('should reject imports of Node core modules (node: prefix)', async () => {
    const code = `import fs from 'node:fs';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'import/no-nodejs-modules');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('builtin module');
  }, 30_000);

  it('should reject imports of Node core modules (bare module name)', async () => {
    const code = `import fs from 'fs';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'import/no-nodejs-modules');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('builtin module');
  }, 30_000);

  it('should allow imports from @temporalio/workflow (false-positive guard)', async () => {
    const code = `import { defineWorkflow } from '@temporalio/workflow';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'import/no-nodejs-modules');
    expect(errors).toHaveLength(0);
  }, 30_000);

  it('should reject fetch() calls', async () => {
    const code = `fetch('https://example.com');
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-globals');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 1');
    expect(errors[0].message).toContain('Temporal activities');
  }, 30_000);

  it('should reject crypto.randomUUID() calls', async () => {
    const code = `crypto.randomUUID();
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-properties');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 1');
  }, 30_000);

  it('should reject crypto.getRandomValues() calls', async () => {
    const code = `crypto.getRandomValues(new Uint8Array(1));
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-properties');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 1');
  }, 30_000);

  it('should reject axios imports', async () => {
    const code = `import axios from 'axios';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 1');
    expect(errors[0].message).toContain('Temporal activities');
  }, 30_000);

  it('should allow local fetch() shadow', async () => {
    const code = `function fetch() {}
fetch();
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-globals');
    expect(errors).toHaveLength(0);
  }, 30_000);

  it('should allow randomUUID on non-crypto objects', async () => {
    const code = `const o = { randomUUID() { return ''; } };
o.randomUUID();
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-properties');
    expect(errors).toHaveLength(0);
  }, 30_000);

  it('should allow axios imports in test files', async () => {
    const code = `import axios from 'axios';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.test.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-imports');
    expect(errors).toHaveLength(0);
  }, 30_000);

  it('should reject fetch() in test files (globals mirrored)', async () => {
    const code = `fetch('https://example.com');
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.test.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'no-restricted-globals');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AGENTS.md rule 1');
  }, 30_000);
});
