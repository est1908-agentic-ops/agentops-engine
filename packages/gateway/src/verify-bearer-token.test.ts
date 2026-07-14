import { describe, expect, it } from 'vitest';
import { verifyBearerToken } from './verify-bearer-token';

const TOKEN = 'my-secret-token-12345';

describe('verifyBearerToken', () => {
  it('accepts a correctly formatted bearer token', () => {
    expect(verifyBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects when the header is undefined (missing header)', () => {
    expect(verifyBearerToken(undefined, TOKEN)).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(verifyBearerToken(`Bearer wrong-token`, TOKEN)).toBe(false);
  });

  it('rejects a header without the Bearer prefix', () => {
    expect(verifyBearerToken(TOKEN, TOKEN)).toBe(false);
  });

  it('rejects a header with differing length', () => {
    expect(verifyBearerToken(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
  });

  it('rejects a header with different casing in Bearer prefix', () => {
    expect(verifyBearerToken(`bearer ${TOKEN}`, TOKEN)).toBe(false);
  });
});
