// Accounts: first setup, login with password / TOTP / passkey / recovery
// code, roles, sessions, user management. The passkey is a software
// authenticator (EC P-256 key) that answers like a browser would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { hotp, totpCounter, verifyTotp, base32Decode, base32Encode } from '../src/auth/totp.js';
import { decode } from '../src/auth/cbor.js';
import { hashPassword, passwordProblem, verifyPassword } from '../src/auth/crypto.js';
import { startApp } from './helpers.js';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// --- tiny CBOR encoder (test side only) ---------------------------------------
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error('unsupported');
}

/** A software passkey: what a phone or a security key would answer. */
function softPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(16);
  let counter = 0;
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(id),
    create(options, origin) {
      const cd = clientData('webauthn.create', options.challenge, origin);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        sha256(options.rp.id),
        Buffer.from([0x45 | 0x18]), // UP + UV + AT, backed up
        Buffer.alloc(4),
        Buffer.alloc(16),
        len,
        id,
        cbor(cose),
      ]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(id),
        rawId: b64u(id),
        type: 'public-key',
        response: { clientDataJSON: b64u(cd), attestationObject: b64u(attestationObject), transports: ['internal'] },
      };
    },
    get(options, origin, { userHandle, flags = 0x05 } = {}) {
      counter += 1;
      const cd = clientData('webauthn.get', options.challenge, origin);
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([flags]), count]);
      const signature = sign('sha256', Buffer.concat([authData, sha256(cd)]), privateKey);
      return {
        id: b64u(id),
        rawId: b64u(id),
        type: 'public-key',
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          userHandle,
        },
      };
    },
  };
}

// --- HTTP client with a cookie jar --------------------------------------------
function client(app) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(`${app.base}/api/${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'x-requested-with': 'integration-creator', 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  };
  return { call, get cookie() { return cookie; } };
}

const totpNow = (secret) => hotp(secret, totpCounter());
const ACCOUNTS = { NO_PASSWORD: '', PUBLIC_URL: 'http://localhost:3000' };
const ORIGIN = 'http://localhost:3000';

async function setupAdmin(app, c = client(app)) {
  const res = await c.call('POST', 'auth/setup', { code: app.auth.setupCode, username: 'alice', password: 'correct horse battery' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return c;
}

async function enableTotp(c) {
  const { body } = await c.call('POST', 'account/totp/setup', {});
  assert.match(body.uri, /^otpauth:\/\/totp\/Gladys%20Integration%20Creator%3Aalice\?secret=/);
  const done = await c.call('POST', 'account/totp/enable', { code: totpNow(body.secret) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { secret: body.secret, recoveryCodes: done.body.recoveryCodes };
}

test('TOTP: RFC 6238 test vector, drift window, no replay', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", T = 59 s -> 94287082 (8 digits) -> 287082.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(hotp(secret, 1), '287082');
  assert.equal(verifyTotp(secret, '287082', { now: 59_000 }), 1);
  assert.equal(verifyTotp(secret, '287082', { now: 59_000 + 30_000 }), 1, 'previous period accepted');
  assert.equal(verifyTotp(secret, '287082', { now: 59_000 + 90_000 }), null, 'too old');
  assert.equal(verifyTotp(secret, '287082', { now: 59_000, lastCounter: 1 }), null, 'a code works once');
  assert.equal(verifyTotp(secret, 'abc', { now: 59_000 }), null);
});

test('passwords: scrypt hash, policy', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$5\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong horse battery', hash), false);
  assert.equal(await verifyPassword('anything', null), false);
  assert.match(passwordProblem('short'), /12 caractères/);
  assert.match(passwordProblem('aaaaaaaaaaaaaaa'), /trop simple/);
  assert.match(passwordProblem('alice-is-my-name', 'Alice'), /nom d’utilisateur/);
  assert.equal(passwordProblem('correct horse battery', 'alice'), null);
});

test('first start: setup code, then the API needs a session', async () => {
  const app = await startApp(ACCOUNTS);
  try {
    const anon = client(app);
    assert.equal((await anon.call('GET', 'status')).status, 401);
    assert.equal((await fetch(`${app.base}/`)).status, 200, 'the login page itself is public');
    const me = await anon.call('GET', 'auth/me');
    assert.equal(me.body.needsSetup, true);
    assert.equal(me.body.user, null);

    assert.match(app.auth.setupCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const bad = await anon.call('POST', 'auth/setup', { code: 'NOPE', username: 'alice', password: 'correct horse battery' });
    assert.equal(bad.status, 400);

    const c = await setupAdmin(app);
    assert.match(c.cookie, /^eic_session=/);
    const again = await anon.call('POST', 'auth/setup', { code: app.auth.setupCode, username: 'bob', password: 'correct horse battery' });
    assert.equal(again.status, 409);

    // 2nd factor required by default: only "my account" until it is set.
    const restricted = await c.call('GET', 'auth/me');
    assert.equal(restricted.body.access, 'mfa');
    assert.equal((await c.call('GET', 'dashboard')).status, 403);
    assert.equal((await c.call('GET', 'account')).status, 200);
    await enableTotp(c);
    assert.equal((await c.call('GET', 'auth/me')).body.access, 'full');
    assert.equal((await c.call('GET', 'status')).status, 200);
  } finally {
    await app.close();
  }
});

test('APP_PASSWORD creates the first administrator', async () => {
  const app = await startApp({ ...ACCOUNTS, APP_USER: 'root', APP_PASSWORD: 'a-long-enough-pass' });
  try {
    assert.equal(app.auth.setupCode, null);
    const c = client(app);
    const res = await c.call('POST', 'auth/login', { username: 'root', password: 'a-long-enough-pass' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'admin');
    assert.match(res.setCookie, /HttpOnly; SameSite=Strict/);
  } finally {
    await app.close();
  }
});

test('login with password + TOTP, replay refused, recovery code works once', async () => {
  const app = await startApp(ACCOUNTS);
  try {
    const admin = await setupAdmin(app);
    const { secret, recoveryCodes } = await enableTotp(admin);
    assert.equal(recoveryCodes.length, 10);

    const c = client(app);
    const wrong = await c.call('POST', 'auth/login', { username: 'alice', password: 'nope nope nope' });
    assert.equal(wrong.status, 401);
    const unknown = await c.call('POST', 'auth/login', { username: 'nobody', password: 'nope nope nope' });
    assert.equal(unknown.body.error, wrong.body.error, 'same message: no account enumeration');

    const step1 = await c.call('POST', 'auth/login', { username: 'alice', password: 'correct horse battery' });
    assert.deepEqual(step1.body.mfa.methods, ['totp', 'recovery']);
    assert.equal(step1.setCookie, null, 'no session before the 2nd factor');
    // The code used during the setup cannot be used again.
    const replay = await c.call('POST', 'auth/login/totp', { ticket: step1.body.mfa.ticket, code: totpNow(secret) });
    assert.equal(replay.status, 401);

    const r1 = await c.call('POST', 'auth/login', { username: 'alice', password: 'correct horse battery' });
    const ok = await c.call('POST', 'auth/login/recovery', { ticket: r1.body.mfa.ticket, code: recoveryCodes[0].toUpperCase() });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recoveryLeft, 9);
    const r2 = await c.call('POST', 'auth/login', { username: 'alice', password: 'correct horse battery' });
    const reused = await c.call('POST', 'auth/login/recovery', { ticket: r2.body.mfa.ticket, code: recoveryCodes[0] });
    assert.equal(reused.status, 401);

    // Ticket: 5 wrong codes, then the password must be typed again.
    const r3 = await c.call('POST', 'auth/login', { username: 'alice', password: 'correct horse battery' });
    for (let i = 0; i < 4; i += 1) await c.call('POST', 'auth/login/totp', { ticket: r3.body.mfa.ticket, code: '000000' });
    const last = await c.call('POST', 'auth/login/totp', { ticket: r3.body.mfa.ticket, code: '000000' });
    assert.match(last.body.error, /mot de passe/);
  } finally {
    await app.close();
  }
});

test('passkeys: register, log in without password, refused on bad signature / origin / IP address', async () => {
  const app = await startApp(ACCOUNTS);
  try {
    const admin = await setupAdmin(app);
    const key = softPasskey();
    const options = await admin.call('POST', 'account/passkeys/options', {});
    assert.equal(options.status, 200);
    assert.equal(options.body.rp.id, 'localhost');
    assert.equal(options.body.authenticatorSelection.userVerification, 'required');
    const userHandle = options.body.user.id;
    const added = await admin.call('POST', 'account/passkeys', { credential: key.create(options.body, ORIGIN), name: 'Téléphone' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.recoveryCodes.length, 10);
    assert.equal((await admin.call('GET', 'auth/me')).body.access, 'full', 'a passkey is a 2nd factor');

    const account = await admin.call('GET', 'account');
    assert.equal(account.body.passkeyList[0].name, 'Téléphone');
    assert.equal(account.body.passkeyList[0].backedUp, true);

    // Passwordless login.
    const c = client(app);
    const login = await c.call('POST', 'auth/passkey/options', {});
    assert.deepEqual(login.body.allowCredentials, []);
    const done = await c.call('POST', 'auth/passkey/login', { credential: key.get(login.body, ORIGIN, { userHandle }) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.username, 'alice');

    // Challenge used once only.
    const again = await c.call('POST', 'auth/passkey/login', { credential: key.get(login.body, ORIGIN, { userHandle }) });
    assert.equal(again.status, 400);

    // Phishing site: other origin.
    const o2 = await c.call('POST', 'auth/passkey/options', {});
    const phish = await c.call('POST', 'auth/passkey/login', { credential: key.get(o2.body, 'http://evil.localhost:3000') });
    assert.equal(phish.status, 401);

    // No PIN / biometrics.
    const o3 = await c.call('POST', 'auth/passkey/options', {});
    const noUv = await c.call('POST', 'auth/passkey/login', { credential: key.get(o3.body, ORIGIN, { flags: 0x01 }) });
    assert.equal(noUv.status, 401);

    // Forged signature.
    const o4 = await c.call('POST', 'auth/passkey/options', {});
    const forged = key.get(o4.body, ORIGIN);
    forged.response.signature = b64u(randomBytes(70));
    assert.equal((await c.call('POST', 'auth/passkey/login', { credential: forged })).status, 401);

    // Unknown passkey.
    const o5 = await c.call('POST', 'auth/passkey/options', {});
    assert.equal((await c.call('POST', 'auth/passkey/login', { credential: softPasskey().get(o5.body, ORIGIN) })).status, 401);

    // As a 2nd factor after the password: only this user's passkeys are offered.
    const step1 = await c.call('POST', 'auth/login', { username: 'alice', password: 'correct horse battery' });
    assert.deepEqual(step1.body.mfa.methods, ['passkey', 'recovery']);
    const o6 = await c.call('POST', 'auth/passkey/options', { ticket: step1.body.mfa.ticket });
    assert.deepEqual(o6.body.allowCredentials.map((x) => x.id), [key.id]);
    assert.equal((await c.call('POST', 'auth/passkey/login', { credential: key.get(o6.body, ORIGIN) })).status, 200);

    // The last 2nd factor cannot be removed while it is mandatory.
    const del = await admin.call('POST', `account/passkeys/${key.id}/delete`, {});
    assert.equal(del.status, 409);
  } finally {
    await app.close();
  }
  // Passkeys need a domain name: plain IP address refused.
  const ip = await startApp({ NO_PASSWORD: '' });
  try {
    const c = await setupAdmin(ip);
    const res = await c.call('POST', 'account/passkeys/options', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /nom de domaine/);
  } finally {
    await ip.close();
  }
});

test('the CBOR decoder refuses truncated input', () => {
  assert.throws(() => decode(Buffer.from([0x5a, 0, 0, 0, 10, 1])), /tronqué/);
  assert.deepEqual(decode(Buffer.from([0x82, 0x01, 0x20])), [1, -1]);
});

test('roles, user management and the GitHub token set from the web page', async () => {
  const app = await startApp(ACCOUNTS);
  try {
    const admin = await setupAdmin(app);
    await enableTotp(admin);

    // Admin creates a member, with a generated temporary password.
    const created = await admin.call('POST', 'users', { username: 'bob', role: 'member' });
    assert.equal(created.status, 200);
    assert.match(created.body.password, /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/);
    assert.equal((await admin.call('POST', 'users', { username: 'BOB', role: 'member' })).status, 409);

    const bob = client(app);
    await bob.call('POST', 'auth/login', { username: 'bob', password: created.body.password });
    assert.equal((await bob.call('GET', 'auth/me')).body.access, 'password', 'temporary password must be changed');
    assert.equal((await bob.call('GET', 'dashboard')).status, 403);
    const changed = await bob.call('POST', 'account/password', { current: created.body.password, password: 'a fresh secret phrase' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.access, 'mfa');

    // MFA optional: bob can work right away.
    assert.equal((await admin.call('PUT', 'security', { requireMfa: false })).body.requireMfa, false);
    assert.equal((await bob.call('GET', 'auth/me')).body.access, 'full');

    // Members cannot manage users nor change the settings (tokens).
    assert.equal((await bob.call('GET', 'users')).status, 403);
    assert.equal((await bob.call('PUT', 'settings', { githubToken: 'github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxx' })).status, 403);

    // Admin sets the GitHub token on the web page.
    assert.equal((await admin.call('PUT', 'settings', { githubToken: 'not-a-token' })).status, 400);
    const saved = await admin.call('PUT', 'settings', { githubToken: 'github_pat_abcdefghijklmnopqrstuvwxyz0123' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.githubTokenSet, true);
    assert.equal(saved.body.githubTokenSource, 'web');
    assert.equal(JSON.stringify(saved.body).includes('github_pat_abc'), false, 'never sent back');
    assert.equal((await admin.call('GET', 'status')).body.githubTokenSet, true);

    // Viewer: read only.
    const bobId = created.body.user.id;
    await admin.call('PUT', `users/${bobId}`, { role: 'viewer' });
    assert.equal((await bob.call('GET', 'dashboard')).status !== 403, true);
    assert.equal((await bob.call('POST', 'refresh')).status, 403);

    // Last administrator protected; disabling closes the sessions.
    const aliceId = (await admin.call('GET', 'auth/me')).body.user.id;
    assert.equal((await admin.call('PUT', `users/${aliceId}`, { role: 'member' })).status, 409);
    assert.equal((await admin.call('DELETE', `users/${aliceId}`)).status, 409);
    await admin.call('PUT', `users/${bobId}`, { disabled: true });
    assert.equal((await bob.call('GET', 'auth/me')).body.user, null);
    assert.equal((await client(app).call('POST', 'auth/login', { username: 'bob', password: 'a fresh secret phrase' })).status, 401);

    // Reset password: temporary again.
    await admin.call('PUT', `users/${bobId}`, { disabled: false });
    const reset = await admin.call('POST', `users/${bobId}/password`, {});
    const bob2 = client(app);
    const relog = await bob2.call('POST', 'auth/login', { username: 'bob', password: reset.body.password });
    assert.equal(relog.body.access, 'password');

    const audit = await admin.call('GET', 'users/audit');
    assert.ok(audit.body.entries.some((e) => /Jeton GitHub modifié/.test(e.action)));
    assert.ok(audit.body.entries.some((e) => e.action === 'Échec de connexion' && e.ok === false));

    assert.equal((await admin.call('DELETE', `users/${bobId}`)).status, 200);
    assert.equal((await bob2.call('GET', 'auth/me')).body.user, null);
  } finally {
    await app.close();
  }
});

test('sessions: logout, revoke the others, password change closes them', async () => {
  const app = await startApp({ ...ACCOUNTS, APP_PASSWORD: 'a-long-enough-pass' });
  try {
    await app.db.update((s) => {
      s.security = { requireMfa: false };
    });
    const login = async () => {
      const c = client(app);
      await c.call('POST', 'auth/login', { username: 'admin', password: 'a-long-enough-pass' });
      return c;
    };
    const a = await login();
    const b = await login();
    const list = await a.call('GET', 'account');
    assert.equal(list.body.sessionList.length, 2);
    assert.equal(list.body.sessionList.filter((s) => s.current).length, 1);

    await a.call('POST', 'account/sessions/revoke-others');
    assert.equal((await b.call('GET', 'auth/me')).body.user, null);
    assert.equal((await a.call('GET', 'auth/me')).body.user.username, 'admin');

    const c = await login();
    const bad = await a.call('POST', 'account/password', { current: 'wrong-password!!', password: 'a brand new password' });
    assert.equal(bad.status, 403);
    await a.call('POST', 'account/password', { current: 'a-long-enough-pass', password: 'a brand new password' });
    assert.equal((await c.call('GET', 'auth/me')).body.user, null, 'other sessions closed');
    assert.equal((await a.call('GET', 'auth/me')).body.user.username, 'admin', 'this one kept');

    const out = await a.call('POST', 'auth/logout');
    assert.match(out.setCookie, /Max-Age=0/);
    assert.equal((await a.call('GET', 'status')).status, 401);
  } finally {
    await app.close();
  }
});

test('login brute force is slowed down per address', async () => {
  const app = await startApp({ ...ACCOUNTS, APP_PASSWORD: 'a-long-enough-pass' });
  try {
    const c = client(app);
    for (let i = 0; i < 10; i += 1) await c.call('POST', 'auth/login', { username: 'admin', password: `bad-password-${i}` });
    const res = await c.call('POST', 'auth/login', { username: 'admin', password: 'a-long-enough-pass' });
    assert.equal(res.status, 429);
  } finally {
    await app.close();
  }
});

test('NO_PASSWORD: no login, account pages turned off', async () => {
  const app = await startApp({ NO_PASSWORD: 'true' });
  try {
    const c = client(app);
    assert.equal((await c.call('GET', 'status')).status, 200);
    const me = await c.call('GET', 'auth/me');
    assert.equal(me.body.authDisabled, true);
    assert.equal(me.body.user.role, 'admin');
    assert.equal((await c.call('GET', 'users')).status, 409);
  } finally {
    await app.close();
  }
});
