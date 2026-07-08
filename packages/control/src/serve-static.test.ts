import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStaticFile } from './serve-static';

describe('resolveStaticFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'control-static-'));
    await writeFile(join(root, 'index.html'), '<html>home</html>');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves index.html for the root path', async () => {
    const file = await resolveStaticFile(root, '/');
    expect(file?.contentType).toBe('text/html; charset=utf-8');
    expect(file?.body.toString('utf8')).toBe('<html>home</html>');
  });

  it('serves a real asset by its exact path', async () => {
    const file = await resolveStaticFile(root, '/assets/app.js');
    expect(file?.contentType).toBe('text/javascript; charset=utf-8');
    expect(file?.body.toString('utf8')).toBe('console.log(1)');
  });

  it('falls back to index.html for an extension-less client-side route', async () => {
    const file = await resolveStaticFile(root, '/runs/platform-1');
    expect(file?.body.toString('utf8')).toBe('<html>home</html>');
  });

  it('returns null for a missing asset that has an extension', async () => {
    expect(await resolveStaticFile(root, '/assets/missing.js')).toBeNull();
  });

  it('returns null for a path-traversal attempt instead of escaping rootDir', async () => {
    await writeFile(join(tmpdir(), 'secret.txt'), 'do not serve me');
    expect(await resolveStaticFile(root, '/../secret.txt')).toBeNull();
  });
});
