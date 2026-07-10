import { createHmac, timingSafeEqual } from 'node:crypto';

// Linear signs webhook deliveries with `Linear-Signature: <hex-hmac-sha256>`
// over the exact raw request body -- no "sha256=" prefix, unlike GitHub.
// Verified the same way: against the raw bytes, before JSON.parse, with
// timingSafeEqual to avoid leaking the correct signature byte-by-byte via
// response-time differences.
//
// Linear also recommends rejecting stale deliveries by `webhookTimestamp`
// (unix ms) as defense-in-depth against replay; 5 minutes is looser than the
// ~60s some integrations use, to tolerate redelivery/clock skew without
// making a secondary check as strict as the HMAC verification itself.
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

export function verifyLinearSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function isFreshLinearWebhook(webhookTimestamp: number | undefined, now: number): boolean {
  if (webhookTimestamp === undefined) {
    return false;
  }
  return Math.abs(now - webhookTimestamp) <= MAX_WEBHOOK_AGE_MS;
}
