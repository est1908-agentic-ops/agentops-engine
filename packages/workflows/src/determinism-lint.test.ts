import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Determinism lint rules', () => {
  let eslint: ESLint;

  // Resolve repo root from this file's location in packages/workflows/src
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');

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
    expect(errors[0].message).toContain('node');
  });

  it('should reject imports of Node core modules (bare module name)', async () => {
    const code = `import fs from 'fs';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'import/no-nodejs-modules');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('node');
  });

  it('should allow imports from @temporalio/workflow (false-positive guard)', async () => {
    const code = `import { defineWorkflow } from '@temporalio/workflow';
export {};`;
    const results = await eslint.lintText(code, {
      filePath: path.join(repoRoot, 'packages/workflows/src/__lint_fixture__.ts'),
    });
    const errors = results[0].messages.filter((msg) => msg.ruleId === 'import/no-nodejs-modules');
    expect(errors).toHaveLength(0);
  });
});
