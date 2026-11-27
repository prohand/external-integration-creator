import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, describePermissions } from '../src/github.js';
import { startFakeGitHub } from './fakes/github.js';
import { checkName } from '../src/launch/checks.js';

test('a missing permission is named, with what it is used for', async () => {
  const fake = await startFakeGitHub();
  fake.addRepo('alice/r', {});
  fake.deny['PUT /repos/alice/r/subscription'] = 'watching=write';
  const gh = new GitHub({ apiUrl: fake.url, token: 'test-token' });
  try {
    await assert.rejects(gh.put('/repos/alice/r/subscription', { subscribed: true }), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.message, 'Droit manquant sur le jeton GitHub : Watching (droit du compte) (écriture) : sert à suivre (« Watch ») le nouveau dépôt.');
      return true;
    });
    await assert.rejects(new GitHub({ apiUrl: fake.url, token: 'wrong' }).put('/repos/alice/r/topics', { names: [] }), /Jeton GitHub refusé/);
    assert.equal(await gh.exists('/repos/alice/nope'), false);
    assert.equal(await gh.readFile('GladysAssistant', 'integration-template-js', 'nope.md'), null);
    assert.match(await gh.readFile('GladysAssistant', 'integration-template-js', 'docs/fr.md'), /^# /);
  } finally {
    await fake.close();
  }
});

test('dry run: writes are reported, never sent', async () => {
  const fake = await startFakeGitHub();
  const seen = [];
  const gh = new GitHub({ apiUrl: fake.url, token: 'test-token', dryRun: true, onSimulated: (c) => seen.push(`${c.method} ${c.path}`) });
  try {
    const { simulated, data } = await gh.post('/repos/x/y/issues', { title: 't' }, { simulate: { number: 1 } });
    assert.equal(simulated, true);
    assert.deepEqual(data, { number: 1 });
    assert.deepEqual(seen, ['POST /repos/x/y/issues']);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('describePermissions handles several permissions', () => {
  assert.match(describePermissions('administration=write; contents=read'), /Administration \(écriture\).*; Contents \(lecture\)/);
  assert.equal(describePermissions(''), null);
});

test('an unreachable source is reported as unknown, not as free', async () => {
  const report = await checkName(
    { displayName: 'Foo', repoName: 'gladys-foo', owner: 'alice' },
    {
      board: async () => ({ columns: { exists: [], progress: [], free: [] } }),
      storeIndex: async () => {
        throw new Error('store down');
      },
      forumSearch: async () => [],
      github: { exists: async () => false },
    },
  );
  assert.equal(report.free, false);
  assert.equal(report.unknown, 1);
  assert.equal(report.conflicts, 0);
  assert.match(report.checks.find((c) => c.source === 'store').message, /store down/);
});
