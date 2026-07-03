import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from './load-env';

describe('loadEnv', () => {
  const previous = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previous;
    }
  });

  it('loads variables from the first .env found walking up from cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentops-load-env-'));
    writeFileSync(join(root, '.env'), 'GITHUB_TOKEN=from-dotenv\n');

    delete process.env.GITHUB_TOKEN;
    loadEnv({ cwd: join(root, 'nested') });

    expect(process.env.GITHUB_TOKEN).toBe('from-dotenv');
  });

  it('does not override env vars already set in the shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentops-load-env-'));
    writeFileSync(join(root, '.env'), 'GITHUB_TOKEN=from-dotenv\n');

    process.env.GITHUB_TOKEN = 'from-shell';
    loadEnv({ cwd: root });

    expect(process.env.GITHUB_TOKEN).toBe('from-shell');
  });
});
