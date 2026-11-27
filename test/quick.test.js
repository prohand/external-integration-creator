import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autofillFromIdea, genericDescriptions, shorten } from '../src/launch/autofill.js';
import { validateLaunch } from '../src/launch/validate.js';
import { startWorld } from './world.js';

test('every form field is filled from the tracker idea, and valid', () => {
  const idea = {
    key: 'idea:9',
    name: 'Météo Truc',
    description: 'Weather forecasts, rain radar and alerts from the Truc national weather service, for any city.',
    docUrl: 'https://www.home-assistant.io/integrations/truc/',
    access: 'Cloud',
    categories: ['environment', 'energy'],
  };
  const filled = autofillFromIdea(idea);
  assert.equal(filled.repoName, 'gladys-meteo-truc');
  assert.equal(filled.description.en, 'Weather forecasts, rain radar and alerts from the Truc national weather service, for any city.');
  assert.equal(filled.description.fr, 'Intégration Météo Truc pour Gladys Assistant.');
  assert.deepEqual(filled.keywords, [], 'no keywords: Gladys 5.1.0 stays enough');
  assert.match(filled.spec, /Reproduire dans Gladys l'intégration Home Assistant « Météo Truc »/);
  assert.match(filled.spec, /home-assistant\.io\/integrations\/truc/);
  const valid = validateLaunch({ ...filled });
  assert.equal(valid.autoFilled, true);

  // Without description nor category, still valid.
  const bare = validateLaunch(autofillFromIdea({ key: 'idea:1', name: 'X1', categories: [] }));
  assert.deepEqual(bare.categories, ['services']);
  assert.equal(bare.description.en, 'X1 integration for Gladys Assistant.');
  for (const text of Object.values(genericDescriptions('A'.repeat(200)))) assert.ok(text.length <= 100);
  assert.equal(shorten('a '.repeat(80), 20).length <= 20, true);
});

test('one click launches from the dashboard idea', async () => {
  const world = await startWorld();
  try {
    await world.call('PUT', 'settings', { claudeToken: 'sk-ant-oat01-x' });
    const { status, body } = await world.call('POST', 'launches/quick', { ideaKey: 'idea:28' });
    assert.equal(status, 200, JSON.stringify(body));
    const done = await world.settle(body.id);
    assert.equal(done.status, 'done');
    const repo = world.github.repos.get('alice/gladys-oral-b');
    const manifest = JSON.parse(world.github.filesOf(repo)['gladys-assistant-integration.json']);
    assert.equal(manifest.name, 'Oral-B');
    assert.equal(manifest.description.en, 'Brosses à dents');
    assert.equal(manifest.description.de, 'Oral-B-Integration für Gladys Assistant.');
    assert.deepEqual(manifest.categories, ['services']);
    assert.equal(manifest.keywords, undefined);
    assert.equal(manifest.gladys_version, '>=5.1.0');
    assert.match(repo.issues[0].body, /- \[ \] Descriptions fr, de et es rédigées dans le manifeste/);
    assert.match(world.github.filesOf(repo)['CLAUDE.md'], /Reproduire dans Gladys l'intégration Home Assistant « Oral-B »/);

    // Already launched (reserved): no second one-click launch.
    const again = await world.call('POST', 'launches/quick', { ideaKey: 'idea:28' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /n’est plus libre/);
    assert.equal((await world.call('POST', 'launches/quick', { ideaKey: 'idea:nope' })).status, 404);
  } finally {
    await world.close();
  }
});
