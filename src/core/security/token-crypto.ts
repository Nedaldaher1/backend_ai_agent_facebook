import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * AES-256-GCM encryption for channel page access tokens at rest.
 *
 * Wire format: `v1:<iv b64>:<auth-tag b64>:<ciphertext b64>` — the version
 * prefix leaves room for key rotation (a future v2 key decrypts new rows while
 * v1 rows still decrypt with the old key).
 *
 * The key is CHANNEL_TOKEN_ENC_KEY: 32 bytes as 64 hex chars
 * (`openssl rand -hex 32`). Decrypted tokens are secrets — never log them,
 * never put them on queue payloads (pass the channel id and decrypt at the
 * send site), never return them from an API.
 */

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce size
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new TokenCryptoError(
      'CHANNEL_TOKEN_ENC_KEY must be 64 hex chars (32 bytes); generate with `openssl rand -hex 32`',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptToken(plaintext: string, keyHex: string): string {
  if (!plaintext) {
    throw new TokenCryptoError('refusing to encrypt an empty token');
  }
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptToken(encrypted: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const parts = encrypted.split(':');
  if (parts.length !== 4) {
    throw new TokenCryptoError('malformed encrypted token (expected 4 parts)');
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  // timingSafeEqual over a padded copy — version strings are public, this just
  // keeps the comparison branch-free and length-guarded.
  const expected = Buffer.from(VERSION);
  const actual = Buffer.from(version);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new TokenCryptoError(`unsupported token-crypto version "${version}"`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new TokenCryptoError('malformed encrypted token (bad iv/tag length)');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext — GCM authentication failed. Do not
    // leak which; both are "cannot decrypt".
    throw new TokenCryptoError('token decryption failed (bad key or data)');
  }
}

/** Exported for tests/config validation. */
export const TOKEN_CRYPTO_KEY_BYTES = KEY_BYTES;
