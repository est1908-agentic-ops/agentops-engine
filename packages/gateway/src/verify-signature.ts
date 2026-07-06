import { createHmac, timingSafeEqual } from 'node:crypto';

// GitHub signs webhook deliveries with HMAC-SHA256 over the exact raw request
// body (X-Hub-Signature-256: sha256=<hex>). Must be checked against the raw
// bytes, before JSON.parse — a re-serialized payload would not reproduce the
// same signature. timingSafeEqual avoids leaking the correct signature one
// byte at a time via response-time differences.
export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
