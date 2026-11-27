import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM, startWorld } from './world.js';
import { releaseBatchMessage } from '../src/launch/texts.js';

const REPO = 'alice/gladys-oral-b';
const stepsOf = (body) => Object.fromEntries(body.publish.stepList.map((s) => [s.id, s]));
const summary = (body) => JSON.stringify(body.publish.stepList.map((s) => [s.id, s.status, s.message]));

/** A real launch, then some development merged on main. */
async function launchedAndDeveloped(world) {
  const { body } = await world.call('POST', 'launches', { ...FORM, simulate: false });
  await world.settle(body.id);
  world.github.commitTo(REPO, 'main', { 'src/oralb.js': 'export {}\n' }, 'Add Oral-B client (#2)');
  return body.id;
}

test('Publier: store check, release, public image, official topic, then the store', async () => {
  const world = await startWorld();
  world.ghcr.public.add(REPO);
  try {
    const id = await launchedAndDeveloped(world);
    const { status, body } = await world.call('POST', `launches/${id}/publish`);
    assert.equal(status, 200, JSON.stringify(body));
    const done = await world.settlePublish(id);
    const steps = stepsOf(done);
    for (const step of ['pub-ready', 'pub-store-check', 'pub-release', 'pub-image', 'pub-topic', 'pub-forum']) {
      assert.equal(steps[step].status, 'done', `${step}: ${steps[step].message}`);
    }
    assert.match(steps['pub-store-check'].message, /réussi \(1 avertissement/);
    assert.match(steps['pub-release'].message, /Version 1\.1\.0 publiée \(image ghcr\.io\/alice\/gladys-oral-b:1\.1\.0\)/);
    assert.match(steps['pub-image'].message, /se télécharge sans compte/);

    const repo = world.github.repos.get(REPO);
    assert.deepEqual(repo.dispatches.map((d) => [d.workflow, d.ref, d.inputs?.['release-type']]), [
      ['store-check.yml', 'main', undefined],
      ['release.yml', 'main', 'minor'],
    ]);
    assert.ok(repo.topics.includes('gladys-assistant-integration'));
    assert.ok(!repo.topics.includes('gladys-integration-wip'));
    assert.equal(done.release.version, '1.1.0');
    assert.equal(done.links.release, 'https://github.com/alice/gladys-oral-b/releases/tag/v1.1.0');

    // Not indexed yet: a warning, "Relancer" later checks again.
    assert.equal(steps['pub-indexer'].status, 'warning');
    assert.match(steps['pub-indexer'].message, /Pas encore dans le store/);
    assert.equal(done.publish.status, 'warning');
    world.store.integrations = [
      { store_slug: REPO, repo_url: `https://github.com/${REPO}`, manifest: { name: 'Oral-B', version: '1.1.0' } },
    ];
    world.app.cache.clear();
    await world.call('POST', `launches/${id}/publish/pub-indexer/retry`);
    const indexed = await world.settlePublish(id);
    assert.match(stepsOf(indexed)['pub-indexer'].message, /Visible dans le store en 1\.1\.0/);
    assert.equal(indexed.publish.status, 'done');

    // The release waits in the "sorties" forum batch.
    const batch = (await world.call('GET', 'forum/batch')).body;
    assert.deepEqual(batch.release.pending.map((p) => p.displayName), ['Oral-B']);
    assert.equal(batch.release.message, 'Oral-B est sortie en v1.1.0 : Brosses à dents Oral-B : état, mode et durée du brossage. https://github.com/alice/gladys-oral-b\n');
    assert.match(batch.release.message, /https:\/\/github\.com\/alice\/gladys-oral-b/);
  } finally {
    await world.close();
  }
});

test('nothing developed yet, or an open PR: nothing is published', async () => {
  const world = await startWorld();
  try {
    const { body } = await world.call('POST', 'launches', { ...FORM, simulate: false });
    await world.settle(body.id);
    await world.call('POST', `launches/${body.id}/publish`);
    let done = await world.settlePublish(body.id);
    assert.equal(stepsOf(done)['pub-ready'].status, 'error');
    assert.match(stepsOf(done)['pub-ready'].message, /code de démonstration du modèle/);
    assert.equal(world.github.repos.get(REPO).dispatches.length, 0);

    world.github.pushBranch(REPO, 'claude/issue-1-x', ['Work'], []);
    await world.call('POST', `launches/${body.id}/dev/pr`);
    world.github.commitTo(REPO, 'main', { a: 'b' });
    await world.call('POST', `launches/${body.id}/publish/pub-ready/retry`);
    done = await world.settlePublish(body.id);
    assert.match(stepsOf(done)['pub-ready'].message, /pull request #2 n’est pas fusionnée/);
  } finally {
    await world.close();
  }
});

test('store check errors are listed, and nothing is released', async () => {
  const world = await startWorld();
  world.ghcr.public.add(REPO);
  world.github.storeCheck = {
    conclusion: 'failure',
    log: '2026-01-01T00:00:00Z   [error] cover_image: download failed (HTTP 404)\n2026-01-01T00:00:01Z   [error] docs/en.md: too short\n',
  };
  try {
    const id = await launchedAndDeveloped(world);
    await world.call('POST', `launches/${id}/publish`);
    let done = await world.settlePublish(id);
    const check = stepsOf(done)['pub-store-check'];
    assert.equal(check.status, 'error');
    assert.equal(check.message, 'Le store refuserait l’intégration : cover_image: download failed (HTTP 404) ; docs/en.md: too short');
    assert.equal(stepsOf(done)['pub-release'].status, 'todo');

    // Fixed: "Relancer" starts a new check, then goes on.
    world.github.storeCheck = { conclusion: 'success', log: '' };
    await world.call('POST', `launches/${id}/publish/pub-store-check/retry`);
    done = await world.settlePublish(id);
    assert.equal(stepsOf(done)['pub-release'].status, 'done', summary(done));
    assert.equal(world.github.repos.get(REPO).dispatches.filter((d) => d.workflow === 'store-check.yml').length, 2);
  } finally {
    await world.close();
  }
});

test('a private image stops before the official topic, with the package settings link', async () => {
  const world = await startWorld();
  try {
    const id = await launchedAndDeveloped(world);
    await world.call('POST', `launches/${id}/publish`);
    let done = await world.settlePublish(id);
    const image = stepsOf(done)['pub-image'];
    assert.equal(image.status, 'error');
    assert.match(image.message, /https:\/\/github\.com\/users\/alice\/packages\/container\/gladys-oral-b\/settings/);
    assert.ok(world.github.repos.get(REPO).topics.includes('gladys-integration-wip'), 'no official topic yet');

    world.ghcr.public.add(REPO);
    await world.call('POST', `launches/${id}/publish/pub-image/retry`);
    done = await world.settlePublish(id);
    assert.equal(stepsOf(done)['pub-topic'].status, 'done');
  } finally {
    await world.close();
  }
});

test('a failed release is re-run (same version), never bumped twice', async () => {
  const world = await startWorld();
  world.ghcr.public.add(REPO);
  world.github.release = { conclusion: 'failure', bump: 'minor' };
  try {
    const id = await launchedAndDeveloped(world);
    await world.call('POST', `launches/${id}/publish`);
    let done = await world.settlePublish(id);
    assert.equal(stepsOf(done)['pub-release'].status, 'error');
    assert.match(stepsOf(done)['pub-release'].message, /build \/ build → Build and push/);

    await world.call('POST', `launches/${id}/publish/pub-release/retry`);
    done = await world.settlePublish(id);
    assert.equal(stepsOf(done)['pub-release'].status, 'done', summary(done));
    assert.equal(world.github.reruns, 1);
    assert.equal(world.github.repos.get(REPO).dispatches.filter((d) => d.workflow === 'release.yml').length, 1);
    assert.equal(done.release.version, '1.1.0');
  } finally {
    await world.close();
  }
});

test('the indexer refusal reason is shown', async () => {
  const world = await startWorld();
  world.ghcr.public.add(REPO);
  try {
    const id = await launchedAndDeveloped(world);
    world.store.rejected = [
      { store_slug: 'Alice/gladys-oral-b', level: 'error', reason: 'cover_image: too large', checked_at: new Date(Date.now() + 60_000).toISOString() },
    ];
    await world.call('POST', `launches/${id}/publish`);
    const done = await world.settlePublish(id);
    assert.equal(stepsOf(done)['pub-indexer'].message, 'L’indexeur du store refuse l’intégration : cover_image: too large');
  } finally {
    await world.close();
  }
});

test('publishing is refused for simulations and unfinished launches', async () => {
  const world = await startWorld();
  try {
    const { body } = await world.call('POST', 'launches', FORM);
    await world.settle(body.id);
    assert.equal((await world.call('POST', `launches/${body.id}/publish`)).status, 409);
  } finally {
    await world.close();
  }
});

test('the "sorties" message refers to the reservation post', () => {
  const item = (name, version, post) => ({
    displayName: name,
    owner: 'alice',
    repoName: `gladys-${name.toLowerCase()}`,
    description: { fr: `${name} dans Gladys.` },
    release: { version },
    forum: { announced: { postNumber: post } },
  });
  assert.equal(
    releaseBatchMessage([item('Velux', '1.1.0', 554), item('Yale', '1.1.0', 554)]),
    'Les 2 réservées au n° 554 sont sorties en v1.1.0 :\n\n- Velux : Velux dans Gladys. https://github.com/alice/gladys-velux\n- Yale : Yale dans Gladys. https://github.com/alice/gladys-yale\n',
  );
  assert.match(releaseBatchMessage([item('Velux', '1.1.0', 554), item('Yale', '1.2.0', 560)]), /^Les 2 sont sorties :\n\n- Velux \(v1\.1\.0\)/);
});
