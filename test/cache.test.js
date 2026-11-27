import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/cache.js';

test('cache keeps a value for its TTL and shares pending loads', async () => {
  let now = 0;
  let calls = 0;
  const cache = new Cache(1000, () => now);
  const loader = async () => ++calls;
  const [a, b] = await Promise.all([cache.get('k', loader), cache.get('k', loader)]);
  assert.equal(a.value, 1);
  assert.equal(b.value, 1);
  now = 500;
  assert.equal((await cache.get('k', loader)).value, 1);
  now = 1500;
  assert.equal((await cache.get('k', loader)).value, 2);
  assert.equal((await cache.get('k', loader, { force: true })).value, 3);
});

test('cache serves the last good value (stale) when a refresh fails', async () => {
  let now = 0;
  const cache = new Cache(1000, () => now);
  await cache.get('k', async () => 'good');
  now = 5000;
  const result = await cache.get('k', async () => {
    throw new Error('down');
  });
  assert.equal(result.value, 'good');
  assert.equal(result.stale, true);
  assert.equal(result.error.message, 'down');
  await assert.rejects(cache.get('other', async () => {
    throw new Error('down');
  }));
});
