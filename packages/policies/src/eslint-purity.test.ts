import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

const lintPolicyFixture = async (code: string) => {
  // filePath must match the packages/policies/src/**/*.ts glob so the rule-2 block applies.
  const [result] = await eslint.lintText(code, {
    filePath: 'packages/policies/src/__fixture__.ts',
  });
  return result.messages;
};

describe('AGENTS.md rule 2 — packages/policies purity is lint-enforced', () => {
  it('bans @temporalio/* imports', async () => {
    const messages = await lintPolicyFixture(
      "import { proxyActivities } from '@temporalio/workflow';\n",
    );
    expect(
      messages.some(
        (m) =>
          /rule 2/i.test(m.message) &&
          m.ruleId === 'no-restricted-imports',
      ),
    ).toBe(true);
  });

  it('bans HTTP clients', async () => {
    const messages = await lintPolicyFixture("import axios from 'axios';\n");
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(
      true,
    );
  });

  it('bans Node core modules', async () => {
    const messages = await lintPolicyFixture(
      "import { readFile } from 'node:fs';\n",
    );
    expect(
      messages.some((m) => m.ruleId === 'import/no-nodejs-modules'),
    ).toBe(true);
  });

  it('allows @agentops/contracts (no false positive)', async () => {
    const messages = await lintPolicyFixture(
      "import { StageSchema } from '@agentops/contracts';\n",
    );
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(
      false,
    );
    expect(
      messages.some((m) => m.ruleId === 'import/no-nodejs-modules'),
    ).toBe(false);
  });
});
