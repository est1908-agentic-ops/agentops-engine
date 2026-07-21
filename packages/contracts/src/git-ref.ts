import { z } from 'zod';

export function isValidGitRefName(name: string): boolean {
  // Reject empty string
  if (name.length === 0) {
    return false;
  }

  // Reject if begins with '-' (critical: prevents git option injection)
  if (name.startsWith('-')) {
    return false;
  }

  // Reject ASCII control chars (0x00–0x1F), DEL (0x7F), and space
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F ]/.test(name)) {
    return false;
  }

  // Reject git-forbidden metacharacters: ~ ^ : ? * [ \
  if (/[~^:?*[\]\\]/.test(name)) {
    return false;
  }

  // Reject '..' (double dot)
  if (name.includes('..')) {
    return false;
  }

  // Reject '@{' (start of reflog syntax)
  if (name.includes('@{')) {
    return false;
  }

  // Reject lone '@' (git uses it to denote HEAD in some contexts)
  if (name === '@') {
    return false;
  }

  // Reject leading '/'
  if (name.startsWith('/')) {
    return false;
  }

  // Reject trailing '/'
  if (name.endsWith('/')) {
    return false;
  }

  // Reject '//' (empty path component)
  if (name.includes('//')) {
    return false;
  }

  // Reject trailing '.' or '.lock'
  if (name.endsWith('.') || name.endsWith('.lock')) {
    return false;
  }

  // Reject any slash-separated component starting with '.' (covers leading '.')
  const components = name.split('/');
  for (const component of components) {
    if (component.startsWith('.')) {
      return false;
    }
    // Also reject components ending with '.lock'
    if (component.endsWith('.lock')) {
      return false;
    }
  }

  return true;
}

export const GitRefNameSchema = z.string().refine(isValidGitRefName, {
  message: 'Invalid git ref name. Must follow git check-ref-format rules: no leading dash, control chars, spaces, or git-forbidden metacharacters.',
});
