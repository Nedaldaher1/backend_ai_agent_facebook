import {
  TokenCryptoError,
  decryptToken,
  encryptToken,
} from '@/core/security/token-crypto';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('token-crypto (AES-256-GCM, v1 format)', () => {
  it('round-trips a page access token', () => {
    const token = 'EAAG-long-lived-page-token-ヴ-عربي-🙂';
    const enc = encryptToken(token, KEY);
    expect(decryptToken(enc, KEY)).toBe(token);
  });

  it('produces the v1:iv:tag:ct wire format with fresh IVs per call', () => {
    const a = encryptToken('tok', KEY);
    const b = encryptToken('tok', KEY);
    expect(a.split(':')).toHaveLength(4);
    expect(a.startsWith('v1:')).toBe(true);
    // GCM with a random nonce must never emit the same ciphertext twice.
    expect(a).not.toBe(b);
  });

  it('never contains the plaintext in the ciphertext', () => {
    const token = 'super-secret-page-token';
    expect(encryptToken(token, KEY)).not.toContain(token);
  });

  it('rejects decryption with the wrong key', () => {
    const enc = encryptToken('tok', KEY);
    expect(() => decryptToken(enc, OTHER_KEY)).toThrow(TokenCryptoError);
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const enc = encryptToken('tok', KEY);
    const parts = enc.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptToken(parts.join(':'), KEY)).toThrow(TokenCryptoError);
  });

  it('rejects malformed inputs and bad keys', () => {
    expect(() => encryptToken('', KEY)).toThrow(TokenCryptoError);
    expect(() => encryptToken('tok', 'deadbeef')).toThrow(TokenCryptoError);
    expect(() => decryptToken('v2:a:b:c', KEY)).toThrow(TokenCryptoError);
    expect(() => decryptToken('not-encrypted', KEY)).toThrow(TokenCryptoError);
  });
});
