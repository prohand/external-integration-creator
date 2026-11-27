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

/** A real (not simulated) launch waiting for its forum announcement. */
async function queueReal(world, name) {
  await world.app.db.update((state) => {
    state.integrations.push({
      id: `id-${name}`,
      createdAt: new Date().toISOString(),
      simulate: false,
      owner: 'alice',
      repoName: `gladys-${name.toLowerCase()}`,
      displayName: name,
      description: { fr: `${name} dans Gladys, en local.` },
      links: {},
      steps: {},
      forum: { queuedAt: new Date().toISOString() },
    });
  });
}

test('launches are announced together in one "Je prends" reply of the topic', async () => {
  const world = await startWorld();
  try {
    await queueReal(world, 'Velux');
    await queueReal(world, 'Oral-B');
    const batch = (await world.call('GET', 'forum/batch')).body;
    assert.deepEqual(batch.pending.map((p) => p.displayName), ['Velux', 'Oral-B']);
    assert.equal(batch.message, 'Je prends :\n\n- Velux : Velux dans Gladys, en local.\n- Oral-B : Oral-B dans Gladys, en local.\n');
    assert.equal(batch.topicUrl, `${world.forum.url}/t/10385`);
    assert.equal(batch.connected, false);

    const ids = batch.pending.map((p) => p.id);
    const refused = await world.call('POST', 'forum/batch', { ids, raw: batch.message });
    assert.equal(refused.status, 400, 'the forum account must be connected');

    await world.connectForum();
    const edited = `${batch.message}\nMerci !`;
    const posted = await world.call('POST', 'forum/batch', { ids: [ids[0]], raw: edited });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.postNumber, 1);
    assert.equal(posted.body.url, `${world.forum.url}/t/integrations-candidates/10385/1`);
    assert.deepEqual(world.forum.posts.map((p) => [p.topic_id, p.raw]), [[10385, edited]]);
    assert.equal(world.forum.topics.length, 0, 'no topic per integration');

    // Only the remaining one is still waiting.
    const after = (await world.call('GET', 'forum/batch')).body;
    assert.deepEqual(after.pending.map((p) => p.displayName), ['Oral-B']);
    const velux = (await world.call('GET', 'launches/id-Velux')).body;
    assert.equal(velux.forum.announced.postNumber, 1);
    assert.equal(velux.links.forum, posted.body.url);
  } finally {
    await world.close();
  }
});

test('in DRY_RUN the batch is not posted', async () => {
  const world = await startWorld({ env: { DRY_RUN: 'true' } });
  try {
    await queueReal(world, 'Velux');
    await world.connectForum();
    const { body } = await world.call('POST', 'forum/batch', { ids: ['id-Velux'], raw: 'Je prends : Velux' });
    assert.equal(body.simulated, true);
    assert.equal(world.forum.posts.length, 0);
  } finally {
    await world.close();
  }
});

test('the name check reads the mentions in the community topic', async () => {
  const world = await startWorld({
    forum: {
      posts: [
        { topic_id: 10385, post_number: 1, raw: 'Liste : Oral-B, Velux…', username: 'pierre-gilles', created_at: '2026-07-27T00:00:00Z' },
        { topic_id: 10385, post_number: 554, raw: 'Je prends : Oral-B', username: 'bob', created_at: '2026-11-27T10:00:00Z' },
      ],
    },
  });
  try {
    const report = (await world.call('GET', 'check-name?displayName=Oral-B&repoName=gladys-oral-b')).body;
    const forum = report.checks.find((c) => c.source === 'forum');
    assert.equal(forum.ok, true);
    assert.match(forum.message, /citée 1 fois/);
    assert.equal(forum.notes.length, 1, 'the first post (the list) is ignored');
    assert.match(forum.notes[0].text, /n° 554 par bob \(2026-11-27\)/);
    assert.equal(forum.notes[0].link, `${world.forum.url}/t/10385/554`);
    assert.equal(report.mentions, 1);

    // The launch goes on, with a warning on the name check.
    const { body } = await world.call('POST', 'launches', { ...FORM });
    const done = await world.settle(body.id);
    const first = done.stepList[0];
    assert.equal(first.status, 'warning');
    assert.match(first.message, /cité dans le sujet des intégrations/);
    assert.equal(done.stepList.at(-1).status, 'done');
  } finally {
    await world.close();
  }
});

test('forum titles are recognized', () => {
  assert.equal(integrationNameFromTitle('Intégration externe - Oral-B'), 'Oral-B');
  assert.equal(integrationNameFromTitle('Integration externe : Velux'), 'Velux');
  assert.equal(integrationNameFromTitle('Autre sujet'), null);
});
