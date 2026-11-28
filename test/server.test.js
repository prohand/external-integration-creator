import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { ConfigError, loadConfig, normalizeBasePath } from '../src/config.js';
import { createBasicAuth, hostName, isHostAllowed } from '../src/web.js';
import { redact, registerSecret } from '../src/log.js';
import { startFakeTracker } from './fakes/tracker.js';
import { startApp } from './helpers.js';

const POST = { method: 'POST', headers: { 'x-requested-with': 'integration-creator' } };

test('BASE_PATH is normalized', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('gladys/creator/'), '/gladys/creator');
  assert.throws(() => normalizeBasePath('/a/../b'));
});

test('dashboard API returns the three columns from the fake tracker', async () => {
  const tracker = await startFakeTracker();
  const app = await startApp({ TRACKER_BASE_URL: tracker.url });
  try {
    const res = await fetch(`${app.base}/api/dashboard`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.counts, { exists: 6, progress: 3, free: 3 });
    assert.ok(data.columns.free.every((c) => c.key && c.name));
    // Second call is served from the cache.
    await fetch(`${app.base}/api/dashboard`);
    assert.equal(tracker.requests.length, 2);
    // Refresh forces a new download.
    const refreshed = await fetch(`${app.base}/api/refresh`, POST);
    assert.equal(refreshed.status, 200);
    assert.equal(tracker.requests.length, 4);
  } finally {
    await app.close();
    await tracker.close();
  }
});

test('a tracker format change is reported clearly', async () => {
  const tracker = await startFakeTracker({ 'liste-ha-gladys.csv': 'N°,Nom\n1,Foo\n' });
  const app = await startApp({ TRACKER_BASE_URL: tracker.url });
  try {
    const res = await fetch(`${app.base}/api/dashboard`);
    assert.equal(res.status, 502);
    const { error } = await res.json();
    assert.match(error, /format du tracker a changé/);
    assert.match(error, /Statut Gladys/);
  } finally {
    await app.close();
    await tracker.close();
  }
});

test('stale data is served with a warning when the tracker goes down', async () => {
  const tracker = await startFakeTracker();
  const app = await startApp({ TRACKER_BASE_URL: tracker.url });
  try {
    await (await fetch(`${app.base}/api/dashboard`)).json();
    await tracker.close();
    const data = await (await fetch(`${app.base}/api/refresh`, POST)).json();
    assert.equal(data.stale, true);
    assert.match(data.warning, /cache/);
    assert.equal(data.counts.free, 3);
  } finally {
    await app.close();
  }
});

test('changing requests need the app header (no cross-site POST)', async () => {
  const tracker = await startFakeTracker();
  const app = await startApp({ TRACKER_BASE_URL: tracker.url });
  try {
    assert.equal((await fetch(`${app.base}/api/refresh`, { method: 'POST' })).status, 403);
    const cross = await fetch(`${app.base}/api/refresh`, {
      method: 'POST',
      headers: { 'x-requested-with': 'integration-creator', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(cross.status, 403);
    assert.equal((await fetch(`${app.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${app.base}/api/dashboard`, POST)).status, 405);
  } finally {
    await app.close();
    await tracker.close();
  }
});

test('works under a BASE_PATH, with <base href> and a redirect', async () => {
  const app = await startApp({ BASE_PATH: '/gladys/creator/' });
  try {
    const redirect = await fetch(`${app.base}/gladys/creator`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/gladys/creator/');

    const page = await fetch(`${app.base}/gladys/creator/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<base href="\/gladys\/creator\/" \/>/);

    const status = await fetch(`${app.base}/gladys/creator/api/status`);
    assert.equal((await status.json()).dryRun, false);
    assert.equal((await fetch(`${app.base}/api/status`)).status, 404);
    assert.equal((await fetch(`${app.base}/gladys/creator/app.js`)).status, 200);
    assert.equal((await fetch(`${app.base}/gladys/creator/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
  } finally {
    await app.close();
  }
});

test('Basic Auth protects everything but /healthz', async () => {
  const app = await startApp({ APP_PASSWORD: 's3cret-pass-long', APP_USER: 'me', NO_PASSWORD: '' });
  const auth = (u, p) => ({ headers: { authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` } });
  try {
    const anon = await fetch(`${app.base}/`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(`${app.base}/`, auth('me', 'wrong'))).status, 401);
    assert.equal((await fetch(`${app.base}/`, auth('me', 's3cret-pass-long'))).status, 200);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
    // Brute force is slowed down per address.
    for (let i = 0; i < 10; i += 1) await fetch(`${app.base}/`, auth('me', `bad${i}`));
    assert.equal((await fetch(`${app.base}/`, auth('me', 's3cret-pass-long'))).status, 429);
  } finally {
    await app.close();
  }
});

test('the app never starts open by accident', () => {
  assert.throws(() => loadConfig({}), (err) => err instanceof ConfigError && /APP_PASSWORD/.test(err.message));
  assert.throws(() => loadConfig({ APP_PASSWORD: 'short' }), /12 caractères minimum/);
  assert.equal(loadConfig({ APP_PASSWORD: 'a-long-enough-pass' }).appPassword, 'a-long-enough-pass');
  assert.equal(loadConfig({ NO_PASSWORD: 'true' }).noPassword, true);
  assert.equal(loadConfig({ NO_PASSWORD: 'true' }).trustProxy, false, 'X-Forwarded-* ignored by default');
});

test('a spoofed X-Forwarded-For cannot dodge the lockout', async () => {
  const bad = { authorization: `Basic ${Buffer.from('admin:bad').toString('base64')}` };
  // Default (no proxy): the header is ignored, the socket address counts.
  const direct = await startApp({ APP_PASSWORD: 'pw-123456789012', NO_PASSWORD: '' });
  try {
    for (let i = 0; i < 10; i += 1) {
      await fetch(`${direct.base}/`, { headers: { ...bad, 'x-forwarded-for': `198.51.100.${i}` } });
    }
    assert.equal((await fetch(`${direct.base}/`, { headers: { ...bad, 'x-forwarded-for': '198.51.100.99' } })).status, 429);
  } finally {
    await direct.close();
  }
  // Behind a proxy: the last entry (appended by the proxy) counts, not the client's.
  const proxied = await startApp({ APP_PASSWORD: 'pw-123456789012', NO_PASSWORD: '', TRUST_PROXY: 'true' });
  try {
    const via = (spoofed, real) => ({ headers: { ...bad, 'x-forwarded-for': `${spoofed}, ${real}` } });
    for (let i = 0; i < 10; i += 1) await fetch(`${proxied.base}/`, via(`10.0.0.${i}`, '203.0.113.7'));
    assert.equal((await fetch(`${proxied.base}/`, via('10.9.9.9', '203.0.113.7'))).status, 429);
    assert.equal((await fetch(`${proxied.base}/`, via('10.9.9.9', '203.0.113.8'))).status, 401);
  } finally {
    await proxied.close();
  }
});

test('failures are limited globally and the tracked addresses are capped', () => {
  let t = 0;
  const check = createBasicAuth({
    user: 'me',
    password: 'a-long-enough-pass',
    limits: { window: 1000, perAddress: 10, global: 5, maxTracked: 3 },
    now: () => t,
  });
  const req = { headers: { authorization: `Basic ${Buffer.from('me:bad').toString('base64')}` } };
  const good = { headers: { authorization: `Basic ${Buffer.from('me:a-long-enough-pass').toString('base64')}` } };
  for (let i = 0; i < 5; i += 1) assert.equal(check(req, `ip-${i}`).status, 401);
  assert.ok(check.tracked() <= 3, 'memory stays bounded');
  assert.equal(check(req, 'ip-new').status, 429, 'every address is slowed down past the global limit');
  assert.equal(check(good, 'ip-owner').status, 429);
  t = 2000; // window over
  assert.equal(check(good, 'ip-owner').ok, true);
});

test('DNS rebinding: unknown host names are refused', async () => {
  const app = await startApp({ ALLOWED_HOSTS: 'creator.example.org, *.lan.example.org' });
  // fetch() cannot set Host: plain node:http does.
  const asHost = (host, path = '/api/status') =>
    new Promise((resolve, reject) => {
      const req = request(`${app.base}${path}`, { headers: { host } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(body) }));
      });
      req.on('error', reject).end();
    });
  try {
    assert.equal((await asHost('evil.example.com')).status, 421);
    assert.match((await (await asHost('evil.example.com')).json()).error, /ALLOWED_HOSTS/);
    assert.equal((await asHost('creator.example.org')).status, 200);
    assert.equal((await asHost('creator.example.org:443')).status, 200);
    assert.equal((await asHost('box.lan.example.org')).status, 200);
    assert.equal((await asHost('localhost:3000')).status, 200);
    assert.equal((await asHost('192.168.1.20:3000')).status, 200);
    assert.equal((await asHost('[::1]:3000')).status, 200);
    assert.equal((await asHost('evil.example.com', '/healthz')).status, 200);
  } finally {
    await app.close();
  }
  assert.equal(isHostAllowed('lan.example.org', ['*.lan.example.org']), false);
  assert.equal(hostName('[::1]:80'), '::1');
});

test('secrets are masked in log output', () => {
  registerSecret('super-secret-value');
  assert.equal(redact('token=super-secret-value'), 'token=***');
  assert.equal(redact('ghp_abcdefghijklmnop1234'), 'ghp_***');
  assert.deepEqual(redact({ githubToken: 'x', ok: 'super-secret-value!' }), { githubToken: '***', ok: '***!' });
});
