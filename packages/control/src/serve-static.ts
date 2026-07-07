import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  contentType: string;
  body: Buffer;
}

/**
 * Resolves a URL path to a file under rootDir, falling back to index.html
 * for any path with no recognized extension -- client-side routes like
 * /runs/:workflowId have no matching file on disk and must still serve the
 * SPA shell. Returns null if nothing resolves; the caller responds 404.
 */
export async function resolveStaticFile(rootDir: string, urlPath: string): Promise<StaticFile | null> {
  const resolvedRoot = resolve(rootDir);
  const hasExtension = extname(urlPath) !== '';
  const relativePath = urlPath === '/' || !hasExtension ? 'index.html' : urlPath.replace(/^\//, '');
  const filePath = resolve(join(resolvedRoot, relativePath));

  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}/`)) {
    return null;
  }

  try {
    const body = await readFile(filePath);
    const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    return { contentType, body };
  } catch {
    return null;
  }
}
