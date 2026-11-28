// -----------------------------------------------------------------------------
// Small crypto helpers for the accounts: password hashing (scrypt), random
// tokens, base64url, constant-time comparisons. Node's crypto only.
// -----------------------------------------------------------------------------

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

// OWASP "N=2^14, r=8, p=5": 16 MiB per hash, fits the 128 MiB container.
const SCRYPT = { N: 2 ** 14, r: 8, p: 5, keylen: 32 };

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (value) => Buffer.from(String(value ?? ''), 'base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest();
export const sha256hex = (value) => createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a, b) {
  return timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// One hash at a time: a burst of logins cannot exhaust the container memory.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** "scrypt$N$r$p$salt$hash" (base64url). */
export function hashPassword(password) {
  return serialized(async () => {
    const salt = randomBytes(16);
    const key = await scryptAsync(String(password).normalize('NFKC'), salt, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(key)].join('$');
  });
}

// Used when the account does not exist: same work, so the answer time does
// not tell whether a user name exists.
let dummy = null;
const dummyHash = () => (dummy ??= hashPassword(randomToken()));

export function verifyPassword(password, stored) {
  const reference = stored ? Promise.resolve(stored) : dummyHash();
  return serialized(async () => {
    const parts = String(await reference).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, salt, hash] = parts;
    const expected = fromB64url(hash);
    const key = await scryptAsync(String(password ?? '').normalize('NFKC'), fromB64url(salt), {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      keylen: expected.length,
    });
    return Boolean(stored) && timingSafeEqual(key, expected);
  });
}

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password, username = '') {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) return `Mot de passe trop court : ${MIN_PASSWORD_LENGTH} caractères minimum.`;
  if (value.length > MAX_PASSWORD_LENGTH) return `Mot de passe trop long : ${MAX_PASSWORD_LENGTH} caractères maximum.`;
  if (username && value.toLowerCase().includes(String(username).toLowerCase())) {
    return 'Le mot de passe ne doit pas contenir le nom d’utilisateur.';
  }
  if (new Set(value).size < 5) return 'Mot de passe trop simple (trop de caractères répétés).';
  return null;
}

// Recovery codes: 10 × "xxxxx-xxxxx", no ambiguous characters (0/o, 1/l/i).
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomCode(length) {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i += 1) {
    if (i >= bytes.length) return out + randomCode(length - out.length);
    // Rejection sampling: no modulo bias.
    if (bytes[i] < 256 - (256 % CODE_ALPHABET.length)) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => `${randomCode(5)}-${randomCode(5)}`);
}

export function normalizeRecoveryCode(value) {
  const clean = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean.length === 10 ? `${clean.slice(0, 5)}-${clean.slice(5)}` : null;
}
