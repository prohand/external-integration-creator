import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishUserApiKey, integrationNameFromTitle, startUserApiKey } from '../src/sources/forum.js';
import { FORM, startWorld } from './world.js';

test('connecting the forum: open, approve, paste the code (OAEP)', async () => {
  const world = await startWorld();
  try {
    const { body: start } = await world.call('POST', 'forum/connect');
    const url = new URL(start.url);
    assert.equal(url.origin + url.pathname, `${world.forum.url}/user-api-key/new`);
    assert.equal(url.searchParams.get('application_name'), 'External Integration Creator');
    assert.equal(url.searchParams.get('scopes'), 'read,write');
    assert.equal(url.searchParams.get('padding'), 'oaep');
    assert.equal(url.searchParams.get('auth_redirect'), null, 'no callback: nothing exposed on the Internet');
    assert.match(url.searchParams.get('public_key'), /^-----BEGIN PUBLIC KEY-----/);
    assert.equal((await world.call('GET', 'settings')).body.forumPending, true);

    const code = world.forum.approve(start.url);
    const { status, body } = await world.call('POST', 'forum/complete', { payload: code });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.forumConnected, true);
    assert.equal(body.forumUsername, 'alice');
    assert.equal(body.forumPending, false);
    assert.ok(!JSON.stringify(body).includes(world.forum.keys.keys().next().value), 'the key is never sent back');
    assert.equal((await world.call('GET', 'status')).body.forumReady, true);

    // A pasted code cannot be replayed once the connection is done.
    assert.equal((await world.call('POST', 'forum/complete', { payload: code })).status, 409);

    // Disconnecting revokes the key on the forum.
    const off = await world.call('POST', 'forum/disconnect');
    assert.equal(off.body.forumConnected, false);
    assert.equal(world.forum.keys.size, 0);
  } finally {
    await world.close();
  }
});

test('the code of an older forum (PKCS#1 padding) is read too', async () => {
  const world = await startWorld();
  try {
    const { status, body } = await world.connectForum({ padding: 'pkcs1' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.forumConnected, true);
  } finally {
    await world.close();
  }
});

test('a wrong or truncated code is refused clearly', () => {
  const first = startUserApiKey({ forumUrl: 'https://forum.test' });
  const second = startUserApiKey({ forumUrl: 'https://forum.test' });
  assert.throws(() => finishUserApiKey(first.pending, 'abc'), /Code incomplet/);
  // Encrypted for another request: other key pair.
  const params = new URL(second.url).searchParams;
  const other = Buffer.alloc(256, 7).toString('base64');
  assert.throws(() => finishUserApiKey(first.pending, other), /Code illisible|Code refusé/);
  assert.ok(params.get('nonce'));
});

test('the topic is created with the user key, in the chosen category', async () => {
  const world = await startWorld();
  try {
    await world.connectForum();
    await world.call('PUT', 'settings', { forumCategoryId: '99' });
    const cats = (await world.call('GET', 'forum/categories')).body;
    assert.deepEqual(cats.categories.map((c) => c.id), [32, 33, 99]);
    assert.equal(cats.defaultId, 33);
    const { body } = await world.call('POST', 'launches', FORM);
    const done = await world.settle(body.id);
    assert.match(done.stepList.find((s) => s.id === 'forum').log.at(-1).message, /catégorie 99/);
  } finally {
    await world.close();
  }
});

test('forum titles are recognized', () => {
  assert.equal(integrationNameFromTitle('Intégration externe - Oral-B'), 'Oral-B');
  assert.equal(integrationNameFromTitle('Integration externe : Velux'), 'Velux');
  assert.equal(integrationNameFromTitle('Autre sujet'), null);
});
