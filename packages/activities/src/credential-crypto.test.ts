import { describe, expect, it } from 'vitest';
import {
  decryptForManagedProject,
  encryptForManagedProject,
  generateManagedProjectKeyPair,
} from './credential-crypto';

describe('credential-crypto', () => {
  it('round-trips a token through encrypt then decrypt', () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'ghp_super-secret-token');
    expect(decryptForManagedProject(privateKey, blob)).toBe('ghp_super-secret-token');
  });

  it('produces a different ciphertext each time (random ephemeral key + IV)', () => {
    const { publicKey } = generateManagedProjectKeyPair();
    const blobA = encryptForManagedProject(publicKey, 'same-plaintext');
    const blobB = encryptForManagedProject(publicKey, 'same-plaintext');
    expect(blobA).not.toBe(blobB);
  });

  it('cannot be decrypted with a different keypair\'s private key', () => {
    const pairA = generateManagedProjectKeyPair();
    const pairB = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(pairA.publicKey, 'secret');
    expect(() => decryptForManagedProject(pairB.privateKey, blob)).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag catches it, does not silently decrypt garbage)', () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'secret');
    const bytes = Buffer.from(blob, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip the last ciphertext byte
    const tampered = bytes.toString('base64');
    expect(() => decryptForManagedProject(privateKey, tampered)).toThrow();
  });
});
