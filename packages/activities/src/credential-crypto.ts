import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const AES_KEY_LENGTH = 32; // AES-256
// Fixed, non-secret domain-separation string for HKDF -- distinguishes this
// key-derivation use from any other HKDF use of the same shared secret,
// should one ever exist. Not a secret itself.
const HKDF_INFO = Buffer.from('agentops-managed-project-credential');

export interface ManagedProjectKeyPair {
  /** Base64 SPKI DER. Not a secret -- safe to store as a plain chart value. */
  publicKey: string;
  /** Base64 PKCS8 DER. A secret -- SOPS-encrypt it, mount only where decryption happens. */
  privateKey: string;
}

export function generateManagedProjectKeyPair(): ManagedProjectKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: publicKey.toString('base64'), privateKey: privateKey.toString('base64') };
}

function importPublicKey(base64Der: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'spki' });
}

function importPrivateKey(base64Der: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'pkcs8' });
}

function deriveAesKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, AES_KEY_LENGTH));
}

// Self-describing blob so we never depend on the ephemeral public key's DER
// length being some assumed constant: [2-byte BE length][ephemeral pubkey DER][iv][authTag][ciphertext].
function packBlob(
  ephemeralPublicKeyDer: Buffer,
  iv: Buffer,
  authTag: Buffer,
  ciphertext: Buffer,
): Buffer {
  const lengthPrefix = Buffer.alloc(2);
  lengthPrefix.writeUInt16BE(ephemeralPublicKeyDer.length, 0);
  return Buffer.concat([lengthPrefix, ephemeralPublicKeyDer, iv, authTag, ciphertext]);
}

function unpackBlob(blob: Buffer): {
  ephemeralPublicKeyDer: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
} {
  const ephemeralPublicKeyLength = blob.readUInt16BE(0);
  let offset = 2;
  const ephemeralPublicKeyDer = blob.subarray(offset, offset + ephemeralPublicKeyLength);
  offset += ephemeralPublicKeyLength;
  const iv = blob.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = blob.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = blob.subarray(offset);
  return { ephemeralPublicKeyDer, iv, authTag, ciphertext };
}

/**
 * Encrypts `plaintext` for the holder of the matching private key.
 * `packages/control` is meant to hold only `recipientPublicKeyBase64` --
 * by construction, this function's caller cannot decrypt what it just wrote.
 */
export function encryptForManagedProject(
  recipientPublicKeyBase64: string,
  plaintext: string,
): string {
  const recipientPublicKey = importPublicKey(recipientPublicKeyBase64);
  const ephemeral = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const ephemeralPrivateKey = createPrivateKey({
    key: ephemeral.privateKey,
    format: 'der',
    type: 'pkcs8',
  });
  const sharedSecret = diffieHellman({
    privateKey: ephemeralPrivateKey,
    publicKey: recipientPublicKey,
  });
  const aesKey = deriveAesKey(sharedSecret);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return packBlob(ephemeral.publicKey, iv, authTag, ciphertext).toString('base64');
}

/**
 * Decrypts a blob produced by `encryptForManagedProject`. Requires the
 * recipient's private key -- only `cli`/`gateway`/`worker` are ever given
 * it; `packages/control` never imports this function.
 */
export function decryptForManagedProject(
  recipientPrivateKeyBase64: string,
  blobBase64: string,
): string {
  const { ephemeralPublicKeyDer, iv, authTag, ciphertext } = unpackBlob(
    Buffer.from(blobBase64, 'base64'),
  );
  const ephemeralPublicKey = createPublicKey({
    key: ephemeralPublicKeyDer,
    format: 'der',
    type: 'spki',
  });
  const recipientPrivateKey = importPrivateKey(recipientPrivateKeyBase64);
  const sharedSecret = diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: ephemeralPublicKey,
  });
  const aesKey = deriveAesKey(sharedSecret);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
