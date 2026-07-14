import { timingSafeEqual } from 'node:crypto';

// ArgoCD sends Authorization: Bearer <token> to the plugin-generator route.
// The token comparison must be constant-time to prevent timing side-channel
// attacks that could leak the token byte-by-byte (if an attacker can measure
// response latency). timingSafeEqual avoids this by comparing all bytes even
// when an early mismatch is found.
export function verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) {
    return false;
  }
  const expected = `Bearer ${expectedToken}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(authHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
