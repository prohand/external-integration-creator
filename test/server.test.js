import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBasePath } from '../src/config.js';
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

test('optional Basic Auth protects everything but /healthz', async () => {
  const app = await startApp({ APP_PASSWORD: 's3cret-pass', APP_USER: 'me' });
  const auth = (u, p) => ({ headers: { authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` } });
  try {
    const anon = await fetch(`${app.base}/`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(`${app.base}/`, auth('me', 'wrong'))).status, 401);
    assert.equal((await fetch(`${app.base}/`, auth('me', 's3cret-pass'))).status, 200);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
    // Brute force is slowed down per address.
    for (let i = 0; i < 10; i += 1) await fetch(`${app.base}/`, auth('me', `bad${i}`));
    assert.equal((await fetch(`${app.base}/`, auth('me', 's3cret-pass'))).status, 429);
  } finally {
    await app.close();
  }
});

test('X-Forwarded-For is used for the client address behind a proxy', async () => {
  const app = await startApp({ APP_PASSWORD: 'pw-123456', TRUST_PROXY: 'true' });
  try {
    const opts = (ip) => ({
      headers: { 'x-forwarded-for': `${ip}, 10.0.0.1`, authorization: `Basic ${Buffer.from('admin:bad').toString('base64')}` },
    });
    for (let i = 0; i < 10; i += 1) await fetch(`${app.base}/`, opts('203.0.113.7'));
    assert.equal((await fetch(`${app.base}/`, opts('203.0.113.7'))).status, 429);
    assert.equal((await fetch(`${app.base}/`, opts('203.0.113.8'))).status, 401);
  } finally {
    await app.close();
  }
});

test('secrets are masked in log output', () => {
  registerSecret('super-secret-value');
  assert.equal(redact('token=super-secret-value'), 'token=***');
  assert.equal(redact('ghp_abcdefghijklmnop1234'), 'ghp_***');
  assert.deepEqual(redact({ githubToken: 'x', ok: 'super-secret-value!' }), { githubToken: '***', ok: '***!' });
});
