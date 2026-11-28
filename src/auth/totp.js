// -----------------------------------------------------------------------------
// TOTP (RFC 6238): 6 digits, 30 seconds, HMAC-SHA1 — what every
// authenticator app understands (Google Authenticator, Aegis, 2FAS, Bitwarden…).
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP = { digits: 6, period: 30, window: 1 };

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Clé TOTP invalide.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret() {
  return base32Encode(randomBytes(20)); // 160 bits, as RFC 4226 recommends
}

export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP.digits;
  return String(code).padStart(TOTP.digits, '0');
}

export const totpCounter = (now = Date.now()) => Math.floor(now / 1000 / TOTP.period);

/**
 * Checks a code against the current period ± 1 (clock drift). Returns the
 * matching counter, or null. A counter at or below `lastCounter` is refused:
 * a code cannot be used twice.
 */
export function verifyTotp(secret, code, { now = Date.now(), lastCounter = -1 } = {}) {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const current = totpCounter(now);
  for (let delta = -TOTP.window; delta <= TOTP.window; delta += 1) {
    const counter = current + delta;
    if (counter <= lastCounter) continue;
    if (hotp(secret, counter) === clean) return counter;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP.digits), period: String(TOTP.period) });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}
