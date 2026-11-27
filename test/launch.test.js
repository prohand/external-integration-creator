import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM, startWorld } from './world.js';
import { storeEntry } from './fakes/forum-store.js';

test('a simulated launch runs every step and creates nothing', async () => {
  const world = await startWorld();
  try {
    await world.call('PUT', 'settings', { claudeToken: 'sk-ant-oat01-secret-value' });
    await world.connectForum();
    const writesBefore = world.writes().length;
    const { status, body } = await world.call('POST', 'launches', FORM);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.simulate, true);
    assert.equal(body.owner, 'alice', 'owner of the GitHub token');

    const done = await world.settle(body.id);
    const byId = Object.fromEntries(done.stepList.map((s) => [s.id, s]));
    assert.equal(done.status, 'done', JSON.stringify(done.stepList.map((s) => [s.id, s.status, s.message])));
    for (const step of done.stepList) assert.equal(step.status, 'done', `${step.id}: ${step.message}`);
    assert.match(byId['check-name'].message, /Nom libre partout/);
    assert.match(byId['create-repo'].message, /Simulation/);
    assert.match(byId.customize.message, /Simulation : un commit de 13 fichiers/);
    assert.ok(byId.customize.data.preview['docs/de.md'].length >= 300);
    assert.equal(byId.customize.data.preview['package-lock.json'], undefined);
    assert.ok(byId['repo-settings'].log.some((l) => l.message === 'Simulation : PATCH /repos/alice/gladys-oral-b'));
    assert.match(byId['claude-secret'].message, /Simulation/);
    assert.match(byId.forum.message, /Simulation : serait ajoutée au prochain message « Je prends »/);
    assert.match(byId.issue.message, /Claude est sollicité/);
    assert.match(byId.reservation.message, /pas réservée/);

    // Nothing was written anywhere (the forum connection aside), no secret leaked.
    assert.equal(world.writes().length, writesBefore);
    assert.equal((await world.call('GET', 'forum/batch')).body.reserve.pending.length, 0, 'simulations are never announced');
    const dash = (await world.call('GET', 'dashboard')).body;
    assert.ok(dash.columns.free.some((i) => i.key === 'idea:28'));
    assert.ok(!JSON.stringify(done).includes('sk-ant-oat01-secret-value'));
    assert.equal(done.links.codespaces, 'https://codespaces.new/alice/gladys-oral-b');

    // It shows up in "Mes intégrations", and can be forgotten.
    const list = (await world.call('GET', 'launches')).body;
    assert.deepEqual(list.map((i) => [i.displayName, i.status]), [['Oral-B', 'done']]);
    assert.equal(list[0].steps, undefined);
    assert.equal((await world.call('DELETE', `launches/${body.id}`)).status, 200);
    assert.deepEqual((await world.call('GET', 'launches')).body, []);
  } finally {
    await world.close();
  }
});

test('steps tied to Claude are skipped without a token, unchecked steps too', async () => {
  const world = await startWorld();
  try {
    const { body } = await world.call('POST', 'launches', { ...FORM, actions: { watch: false } });
    const done = await world.settle(body.id);
    const byId = Object.fromEntries(done.stepList.map((s) => [s.id, s]));
    assert.equal(byId['claude-secret'].status, 'skipped');
    assert.equal(byId.forum.status, 'done', 'queued for the next batch, the key is only needed to post');
    assert.equal(byId.watch.status, 'skipped');
    assert.match(byId.watch.message, /Désactivée/);
    assert.ok(!byId.customize.data.preview['.github/workflows/claude.yml'], 'no Claude workflow without a token');
    assert.doesNotMatch(byId.issue.message, /Claude/);
    assert.equal(done.status, 'done');
  } finally {
    await world.close();
  }
});

test('a taken name stops the launch at the first step, with the reason', async () => {
  const world = await startWorld({
    store: { integrations: [storeEntry('bob', 'gladys-oralb', 'Oral B')] },
  });
  try {
    const { body } = await world.call('POST', 'launches', FORM);
    const done = await world.settle(body.id);
    const [first, second] = done.stepList;
    assert.equal(done.status, 'error');
    assert.equal(first.status, 'error');
    assert.match(first.message, /Nom déjà pris : Store Gladys \(Déjà dans le store : « Oral B »/);
    assert.equal(second.status, 'todo', 'the launch stops');

    // "Relancer" on a later step is refused while the name check failed.
    const retry = await world.call('POST', `launches/${body.id}/steps/customize/retry`);
    assert.equal(retry.status, 409);
    // Once the conflict is gone, "Relancer" resumes the whole launch.
    world.store.integrations = [];
    world.app.cache.clear();
    assert.equal((await world.call('POST', `launches/${body.id}/steps/check-name/retry`)).status, 200);
    assert.equal((await world.settle(body.id)).status, 'done');
  } finally {
    await world.close();
  }
});

test('the live name check reports every source', async () => {
  const world = await startWorld({
    forum: { topics: [{ id: 7, title: 'Intégration externe - Velux', slug: 'integration-externe-velux' }] },
  });
  world.github.addRepo('alice/gladys-velux', {});
  try {
    const free = await world.call('GET', 'check-name?displayName=Oral-B&repoName=gladys-oral-b&ideaKey=idea:28');
    assert.equal(free.body.free, true);
    assert.equal(free.body.repoUrl, 'https://github.com/alice/gladys-oral-b');
    assert.equal(free.body.image, 'ghcr.io/alice/gladys-oral-b:1.0.0');

    const taken = (await world.call('GET', 'check-name?displayName=Velux&repoName=gladys-velux')).body;
    const bySource = Object.fromEntries(taken.checks.map((c) => [c.source, c]));
    assert.equal(bySource.forum.ok, false);
    assert.equal(bySource.forum.link, `${world.forum.url}/t/integration-externe-velux/7`);
    assert.equal(bySource.github.ok, false);
    assert.equal(bySource.tracker.ok, true);
    assert.equal(taken.conflicts, 2);

    const existing = (await world.call('GET', 'check-name?displayName=Google Cast&repoName=gladys-google-cast')).body;
    assert.equal(existing.checks.find((c) => c.source === 'tracker').ok, false);
  } finally {
    await world.close();
  }
});

test('launch form validation lists every problem', async () => {
  const world = await startWorld();
  try {
    const { status, body } = await world.call('POST', 'launches', {
      ...FORM,
      repoName: 'bad name',
      description: { ...FORM.description, de: 'kurz' },
      categories: ['climate', 'lighting', 'energy', 'security'],
    });
    assert.equal(status, 400);
    assert.deepEqual(Object.keys(body.details).sort(), ['categories', 'description.de', 'repoName']);
  } finally {
    await world.close();
  }
});

test('DRY_RUN=true forces the simulation', async () => {
  const world = await startWorld({ env: { DRY_RUN: 'true' } });
  try {
    const { body } = await world.call('POST', 'launches', { ...FORM, simulate: false });
    assert.equal(body.simulate, true);
    await world.settle(body.id);
    assert.deepEqual(world.writes(), []);
  } finally {
    await world.close();
  }
});

test('the SSE stream is proxy friendly and sends the launch state', async () => {
  const world = await startWorld();
  try {
    const { body } = await world.call('POST', 'launches', FORM);
    await world.settle(body.id);
    const controller = new AbortController();
    const res = await fetch(`${world.app.base}/api/launches/${body.id}/events`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('event: launch')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^retry: 5000\n\n/);
    controller.abort();
  } finally {
    await world.close();
  }
});

test('settings never send secrets back', async () => {
  const world = await startWorld();
  try {
    const saved = await world.call('PUT', 'settings', { claudeToken: 'sk-ant-oat01-very-secret', owner: 'my-org', extraTopics: 'Zigbee, domotique' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.claudeTokenSet, true);
    assert.equal(saved.body.extraTopics, 'zigbee, domotique');
    const read = await world.call('GET', 'settings');
    assert.ok(!JSON.stringify(read.body).includes('very-secret'));
    assert.equal((await world.call('GET', 'status')).body.owner, 'my-org');
    assert.equal((await world.call('PUT', 'settings', { owner: 'bad owner!' })).status, 400);
    const cleared = await world.call('PUT', 'settings', { claudeToken: null });
    assert.equal(cleared.body.claudeTokenSet, false);
  } finally {
    await world.close();
  }
});
