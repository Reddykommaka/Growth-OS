/**
 * Base32 (RFC 4648 §6).
 *
 * Shared by two callers with unrelated reasons for needing it:
 *
 *   - TOTP secrets, because every authenticator app expects base32.
 *   - API keys, because the alphabet contains NO `_` or `-`. The key format is
 *     `gos_live_<prefix>_<secret>`, so an encoding whose own alphabet includes the separator
 *     produces keys that cannot be parsed back. base64url does exactly that, and did: a key
 *     whose random prefix happened to contain `_` split into five fields instead of four and
 *     was rejected as malformed — an intermittent authentication failure affecting roughly
 *     one key in three.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  // Authenticator apps accept unpadded secrets, and padding in a QR payload is noise.
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
