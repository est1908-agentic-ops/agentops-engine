import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature } from './verify-signature';

const SECRET = 'shared-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  it('accepts a correctly signed payload', () => {
    const body = Buffer.from('{"action":"labeled"}');
    expect(verifyGithubSignature(body, sign(body.toString('utf8')), SECRET)).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const body = Buffer.from('{"action":"labeled"}');
    expect(verifyGithubSignature(body, sign(body.toString('utf8'), 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const original = Buffer.from('{"action":"labeled"}');
    const signature = sign(original.toString('utf8'));
    const tampered = Buffer.from('{"action":"closed"}');
    expect(verifyGithubSignature(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects when no signature header is present', () => {
    const body = Buffer.from('{"action":"labeled"}');
    expect(verifyGithubSignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed signature header without throwing', () => {
    const body = Buffer.from('{"action":"labeled"}');
    expect(verifyGithubSignature(body, 'not-a-real-signature', SECRET)).toBe(false);
  });
});
