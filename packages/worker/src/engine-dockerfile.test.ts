import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('installs util-linux so the worker flock coordinator is available', () => {
  const dockerfile = readFileSync(join(process.cwd(), 'images', 'engine', 'Dockerfile'), 'utf8');

  expect(dockerfile).toMatch(/apt-get install[^\n]*util-linux/);
});
