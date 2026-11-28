import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { ConfigError, loadConfig, normalizeBasePath } from '../src/config.js';
import { hostName, isHostAllowed } from '../src/web.js';
import { createLimiter } from '../src/auth/limiter.js';
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

test('the configuration refuses a short APP_PASSWORD and starts without one', () => {
  assert.throws(() => loadConfig({ APP_PASSWORD: 'short' }), (err) => err instanceof ConfigError && /12 caractères minimum/.test(err.message));
  assert.equal(loadConfig({ APP_PASSWORD: 'a-long-enough-pass' }).appPassword, 'a-long-enough-pass');
  assert.equal(loadConfig({}).noPassword, false, 'accounts by default');
  assert.equal(loadConfig({ NO_PASSWORD: 'true' }).noPassword, true);
  assert.equal(loadConfig({ NO_PASSWORD: 'true' }).trustProxy, false, 'X-Forwarded-* ignored by default');
  assert.equal(loadConfig({ PUBLIC_URL: 'https://creator.example.org/' }).publicUrl, 'https://creator.example.org');
  assert.throws(() => loadConfig({ PUBLIC_URL: 'ftp://x' }), /PUBLIC_URL/);
});

test('failures are limited per key, globally, and the tracked keys are capped', () => {
  let t = 0;
  const limiter = createLimiter({ limits: { window: 1000, perKey: 3, global: 5, maxTracked: 3 }, now: () => t });
  for (let i = 0; i < 3; i += 1) limiter.fail('ip-a');
  assert.equal(limiter.blocked('ip-a'), true);
  assert.equal(limiter.blocked('ip-b'), false);
  limiter.fail('ip-c');
  limiter.fail('ip-d');
  assert.equal(limiter.blocked('ip-new'), true, 'every key is slowed down past the global limit');
  limiter.fail('ip-e');
  assert.ok(limiter.tracked() <= 3, 'memory stays bounded');
  t = 2000; // window over
  assert.equal(limiter.blocked('ip-a'), false);
  assert.equal(limiter.blocked('ip-new'), false);
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
