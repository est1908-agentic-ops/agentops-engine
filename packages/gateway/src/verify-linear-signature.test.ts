import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isFreshLinearWebhook, verifyLinearSignature } from './verify-linear-signature';

const secret = 'linear-webhook-secret';

function sign(body: Buffer, withSecret = secret): string {
  return createHmac('sha256', withSecret).update(body).digest('hex');
}

describe('verifyLinearSignature', () => {
  it('accepts a correctly signed body with no "sha256=" prefix', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(verifyLinearSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a missing signature header', () => {
    const body = Buffer.from('{}');
    expect(verifyLinearSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = Buffer.from('{}');
    expect(verifyLinearSignature(body, sign(body, 'wrong-secret'), secret)).toBe(false);
  });

  it('rejects a signature of different length without throwing', () => {
    const body = Buffer.from('{}');
    expect(verifyLinearSignature(body, 'short', secret)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const original = Buffer.from(JSON.stringify({ hello: 'world' }));
    const signature = sign(original);
    const tampered = Buffer.from(JSON.stringify({ hello: 'tampered' }));
    expect(verifyLinearSignature(tampered, signature, secret)).toBe(false);
  });
});

describe('isFreshLinearWebhook', () => {
  const now = 1_700_000_000_000;

  it('accepts a timestamp within the freshness window', () => {
    expect(isFreshLinearWebhook(now - 60_000, now)).toBe(true);
  });

  it('rejects a timestamp older than the freshness window', () => {
    expect(isFreshLinearWebhook(now - 10 * 60_000, now)).toBe(false);
  });

  it('rejects a timestamp from the future beyond the window', () => {
    expect(isFreshLinearWebhook(now + 10 * 60_000, now)).toBe(false);
  });

  it('rejects an undefined timestamp', () => {
    expect(isFreshLinearWebhook(undefined, now)).toBe(false);
  });
});
