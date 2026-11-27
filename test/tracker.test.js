import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTrackerCategories } from '../src/categories.js';
import {
  TrackerFormatError,
  bucketOfStatus,
  buildBoard,
  fetchTracker,
  parseIdeas,
  parseIntegrations,
} from '../src/sources/tracker.js';
import { FIXTURES, startFakeTracker } from './fakes/tracker.js';

const ideas = () => parseIdeas(FIXTURES['liste-ha-gladys.csv']);
const integrations = () => parseIntegrations(FIXTURES['integrations-gladys.csv']);
const names = (items) => items.map((i) => i.name).sort();

test('tracker statuses are kept and sorted into the three columns', () => {
  assert.equal(bucketOfStatus('Libre').bucket, 'free');
  assert.equal(bucketOfStatus('En cours (dépôt GitHub)').bucket, 'progress');
  assert.equal(bucketOfStatus('Annoncée sur le forum').bucket, 'progress');
  for (const s of [
    'Publiée (store)',
    'Native Gladys',
    'Topic store posé, pas encore indexée',
    'Hors store, inactive',
    'Archivée, dépréciée ou supprimée',
  ]) {
    assert.deepEqual(bucketOfStatus(s), { bucket: 'exists', known: true }, s);
  }
  assert.deepEqual(bucketOfStatus('Statut bizarre'), { bucket: 'exists', known: false });
});

test('tracker categories map to store categories', () => {
  assert.deepEqual(mapTrackerCategories('Weather & environment / Energy'), ['environment', 'energy']);
  assert.deepEqual(mapTrackerCategories('Heating & cooling'), ['climate']);
  assert.deepEqual(mapTrackerCategories('Lighting, plugs & covers'), ['lighting']);
  assert.deepEqual(mapTrackerCategories('Inconnue'), []);
});

test('ideas are parsed by header name, unsafe links are dropped', () => {
  const list = ideas();
  assert.equal(list.length, 10);
  const meteo = list.find((i) => i.id === '29');
  assert.equal(meteo.docUrl, null, 'javascript: URL must be ignored');
  assert.equal(meteo.noHardware, true);
  assert.equal(meteo.installs, 5000);
  assert.equal(list.find((i) => i.id === 'F1').description, 'Chromecast, enceintes "Google Nest" et TV');
});

test('columns can be reordered: headers are read, not positions', () => {
  const text = 'Statut Gladys,Intégration Home Assistant,N°\nLibre,Foo,1\n';
  assert.deepEqual(
    parseIdeas(text).map((i) => [i.id, i.name, i.bucket]),
    [['1', 'Foo', 'free']],
  );
});

test('a missing required column raises a clear error', () => {
  assert.throws(
    () => parseIdeas('N°,Intégration Home Assistant\n1,Foo\n'),
    (err) => err instanceof TrackerFormatError && /Statut Gladys/.test(err.message) && /liste-ha-gladys\.csv/.test(err.message),
  );
  assert.throws(() => parseIntegrations('Nom du truc\nx\n'), TrackerFormatError);
});

test('the board links both files and never shows a taken idea as free', () => {
  const board = buildBoard({ ideas: ideas(), integrations: integrations() });
  assert.deepEqual(names(board.columns.free), ['Météo Truc', 'Oral-B', 'Velux']);
  assert.deepEqual(names(board.columns.progress), ['BTHome', 'Ecoflow', 'Signal Messenger']);
  assert.deepEqual(names(board.columns.exists), [
    'AirPlay',
    'Bluetooth',
    'Gladys AirPlay',
    'Google Cast',
    'Mystère',
    'Vieux truc',
  ]);
  const bthome = board.columns.progress.find((i) => i.name === 'BTHome');
  assert.equal(bthome.repo, 'someone/gladys-bthome-pro');
  const airplay = board.columns.exists.find((i) => i.name === 'AirPlay');
  assert.match(airplay.notes[0], /Gladys AirPlay/);
  assert.equal(airplay.status, 'Publiée (store)', 'the effective status is shown, not "Libre"');
  assert.equal(bthome.status, 'En cours (dépôt GitHub)');
  assert.equal(board.columns.exists.find((i) => i.name === 'Mystère').unknownStatus, true);
  assert.deepEqual(board.counts, { exists: 6, progress: 3, free: 3 });
});

test('local reservations move a free idea to "in progress"', () => {
  const board = buildBoard({ ideas: ideas(), integrations: integrations() }, [
    { ideaKey: 'idea:28', name: 'Oral-B', repo: 'me/gladys-oral-b' },
    { ideaKey: null, name: 'Hors liste', repo: 'me/gladys-hors-liste', categories: ['services'] },
  ]);
  const oral = board.columns.progress.find((i) => i.name === 'Oral-B');
  assert.equal(oral.reservedLocally, true);
  assert.equal(oral.repo, 'me/gladys-oral-b');
  assert.ok(board.columns.progress.find((i) => i.key === 'local:me/gladys-hors-liste'));
  assert.ok(!board.columns.free.some((i) => i.name === 'Oral-B'));
});

test('fetchTracker downloads both files from the (fake) tracker', async () => {
  const fake = await startFakeTracker();
  try {
    const data = await fetchTracker({ trackerBaseUrl: fake.url, httpTimeoutMs: 2000 });
    assert.equal(data.ideas.length, 10);
    assert.equal(data.integrations.length, 4);
    assert.deepEqual(fake.requests.map((r) => r.path).sort(), ['/integrations-gladys.csv', '/liste-ha-gladys.csv']);
  } finally {
    await fake.close();
  }
});
