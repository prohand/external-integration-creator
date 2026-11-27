import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM, startWorld } from './world.js';
import { openSecret } from './fakes/github.js';

const REAL = { ...FORM, simulate: false };
const stepsOf = (launch) => Object.fromEntries(launch.stepList.map((s) => [s.id, s]));
const summary = (launch) => JSON.stringify(launch.stepList.map((s) => [s.id, s.status, s.message]));

test('a real launch creates and sets up the repository, end to end', async () => {
  const world = await startWorld();
  try {
    await world.call('PUT', 'settings', { claudeToken: 'sk-ant-oat01-real-secret' });
    const { status, body } = await world.call('POST', 'launches', REAL);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.simulate, false);
    const done = await world.settle(body.id);
    assert.equal(done.status, 'done', summary(done));

    const repo = world.github.repos.get('alice/gladys-oral-b');
    assert.ok(repo, 'repository generated from the template');
    const files = world.github.filesOf(repo);
    const manifest = JSON.parse(files['gladys-assistant-integration.json']);
    assert.equal(manifest.name, 'Oral-B');
    assert.equal(manifest.docker_image, 'ghcr.io/alice/gladys-oral-b:1.0.0');
    assert.ok(files['docs/de.md'] && files['docs/es.md']);
    assert.match(files['.github/workflows/claude.yml'], /claude-code-action@v1/);
    assert.match(files['.github/workflows/ci.yml'], /workflow_dispatch/);
    assert.equal(JSON.parse(files['package.json']).name, 'gladys-oral-b');
    assert.equal(files['docs/fr.md'].includes('Template'), false);

    assert.equal(repo.settings.allow_squash_merge, true);
    assert.equal(repo.settings.allow_merge_commit, false);
    assert.equal(repo.settings.delete_branch_on_merge, true);
    assert.equal(repo.settings.security_and_analysis.secret_scanning.status, 'enabled');
    assert.deepEqual(Object.keys(repo.security).sort(), [
      'automated-security-fixes',
      'private-vulnerability-reporting',
      'vulnerability-alerts',
    ]);
    assert.deepEqual(repo.workflowPermissions, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true });
    assert.ok(repo.topics.includes('gladys-integration-wip'));
    assert.ok(!repo.topics.includes('gladys-assistant-integration'), 'not the official topic yet');
    assert.equal(repo.subscribed, true);
    assert.deepEqual([...repo.labels.keys()], ['claude', 'en cours', 'publication']);
    assert.equal(openSecret(world.github, repo.secrets.CLAUDE_CODE_OAUTH_TOKEN.encrypted_value), 'sk-ant-oat01-real-secret');

    const [issue] = repo.issues;
    assert.match(issue.body, /^@claude /);
    assert.deepEqual(issue.labels, ['en cours', 'claude']);
    assert.equal(done.links.issue, 'https://github.com/alice/gladys-oral-b/issues/1');
    assert.equal(done.issueNumber, 1);

    // The idea is now "in progress" on the dashboard, and waits for the forum batch.
    const dash = (await world.call('GET', 'dashboard')).body;
    const oral = dash.columns.progress.find((i) => i.key === 'idea:28');
    assert.equal(oral.reservedLocally, true);
    assert.equal(oral.repo, 'alice/gladys-oral-b');
    const batch = (await world.call('GET', 'forum/batch')).body;
    assert.deepEqual(batch.pending.map((p) => p.displayName), ['Oral-B']);
    assert.ok(!JSON.stringify(done).includes('real-secret'));

    // The same repository cannot be launched twice.
    assert.equal((await world.call('POST', 'launches', REAL)).status, 409);
  } finally {
    await world.close();
  }
});

test('every step can be run again without breaking anything', async () => {
  const world = await startWorld();
  try {
    const { body } = await world.call('POST', 'launches', REAL);
    await world.settle(body.id);
    const expected = {
      'check-name': /déjà réservé/,
      'create-repo': /Dépôt déjà créé/,
      customize: /Déjà personnalisé/,
      labels: /Étiquettes/,
      issue: /Issue déjà créée : #1/,
      reservation: /En cours/,
    };
    for (const [step, message] of Object.entries(expected)) {
      assert.equal((await world.call('POST', `launches/${body.id}/steps/${step}/retry`)).status, 200);
      const again = stepsOf(await world.settle(body.id))[step];
      assert.equal(again.status, 'done', `${step}: ${again.message}`);
      assert.match(again.message, message);
    }
    const repo = world.github.repos.get('alice/gladys-oral-b');
    assert.equal(repo.issues.length, 1, 'no second issue');
    assert.equal(world.github.repos.size, 2, 'no second repository');
    assert.equal(world.app.db.read().reservations.length, 1);
  } finally {
    await world.close();
  }
});

test('a missing permission on a non-essential step gives a warning, named', async () => {
  const world = await startWorld();
  world.github.deny['PUT /repos/alice/gladys-oral-b/subscription'] = 'watching=write';
  try {
    const { body } = await world.call('POST', 'launches', REAL);
    const done = await world.settle(body.id);
    const steps = stepsOf(done);
    assert.equal(steps.watch.status, 'warning');
    assert.match(steps.watch.message, /Droit manquant sur le jeton GitHub : Watching.*suivre/);
    assert.equal(steps.issue.status, 'done', 'the launch goes on');
    assert.equal(steps.reservation.status, 'done');
    assert.equal(done.status, 'warning');

    // Once the right is given, "Relancer" fixes it.
    delete world.github.deny['PUT /repos/alice/gladys-oral-b/subscription'];
    await world.call('POST', `launches/${body.id}/steps/watch/retry`);
    assert.equal((await world.settle(body.id)).status, 'done');
  } finally {
    await world.close();
  }
});

test('a missing permission on an essential step stops the launch', async () => {
  const world = await startWorld();
  world.github.deny['POST /repos/GladysAssistant/integration-template-js/generate'] = 'administration=write';
  try {
    const { body } = await world.call('POST', 'launches', REAL);
    const done = await world.settle(body.id);
    const steps = stepsOf(done);
    assert.equal(steps['create-repo'].status, 'error');
    assert.match(steps['create-repo'].message, /Administration \(écriture\) : sert à créer le dépôt/);
    assert.equal(steps['wait-branch'].status, 'todo');
    assert.equal(world.app.db.read().reservations.length, 0);
  } finally {
    await world.close();
  }
});

test('without the template flag, the template is copied with the Git Data API', async () => {
  const world = await startWorld({ github: { isTemplate: false } });
  world.github.branchDelay = 2; // the branch shows up after a few polls
  try {
    const { body } = await world.call('POST', 'launches', REAL);
    const done = await world.settle(body.id);
    assert.equal(done.status, 'done', summary(done));
    assert.match(stepsOf(done)['create-repo'].log.map((l) => l.message).join('\n'), /Copie du modèle par l’API Git Data/);
    const files = world.github.filesOf(world.github.repos.get('alice/gladys-oral-b'));
    assert.equal(files['README.md'].startsWith('# Oral-B'), true, 'personalized on top of the copy');
    assert.ok(files['CHANGELOG.md'] && files['test-only'] === undefined);
    assert.equal(JSON.parse(files['gladys-assistant-integration.json']).name, 'Oral-B');
  } finally {
    await world.close();
  }
});

test('a branch that never shows up stops the launch; Relancer resumes it', async () => {
  const world = await startWorld({ env: { BRANCH_WAIT_SECONDS: '0.1' } });
  world.github.branchDelay = 1000;
  try {
    const { body } = await world.call('POST', 'launches', REAL);
    const done = await world.settle(body.id);
    const steps = stepsOf(done);
    assert.equal(steps['wait-branch'].status, 'error');
    assert.match(steps['wait-branch'].message, /n’existe toujours pas/);
    world.github.repos.get('alice/gladys-oral-b').createdDelay = 0;
    await world.call('POST', `launches/${body.id}/steps/wait-branch/retry`);
    assert.equal((await world.settle(body.id)).status, 'done');
  } finally {
    await world.close();
  }
});

test('an existing repository of someone else is never reused', async () => {
  const world = await startWorld();
  world.github.addRepo('alice/gladys-oral-b', { 'README.md': 'mine' });
  try {
    const { body } = await world.call('POST', 'launches', REAL);
    const done = await world.settle(body.id);
    assert.equal(stepsOf(done)['check-name'].status, 'error');
    assert.match(stepsOf(done)['check-name'].message, /Le dépôt alice\/gladys-oral-b existe déjà/);
    assert.equal(world.github.filesOf(world.github.repos.get('alice/gladys-oral-b'))['README.md'], 'mine');
  } finally {
    await world.close();
  }
});

test('a real launch needs a GitHub token', async () => {
  const world = await startWorld({ env: { GITHUB_TOKEN: '' } });
  try {
    const { status, body } = await world.call('POST', 'launches', REAL);
    assert.equal(status, 400);
    assert.match(body.error, /GITHUB_TOKEN/);
  } finally {
    await world.close();
  }
});

test('the token check names the missing permissions without changing anything', async () => {
  const world = await startWorld();
  world.github.addRepo('alice/existing', { 'README.md': 'x' });
  try {
    const ok = (await world.call('POST', 'github/check')).body;
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.login, 'alice');
    assert.equal(ok.repo, 'alice/existing');
    assert.equal(ok.expiresAt, '2027-02-25T10:00:00.000Z');
    const status = Object.fromEntries(ok.permissions.map((p) => [p.key, p.status]));
    assert.deepEqual(status, {
      metadata: 'ok',
      administration: 'ok',
      contents: 'ok',
      issues: 'ok',
      actions: 'ok',
      secrets: 'ok',
      watching: 'ok',
      'workflows-write': 'unknown',
      'secrets-write': 'unknown',
    });
    const repo = world.github.repos.get('alice/existing');
    assert.deepEqual(repo.topics, [], 'nothing changed');
    assert.equal(repo.issues.length, 0);
    assert.deepEqual(Object.keys(repo.refs), ['main']);

    world.github.deny['PUT /repos/alice/existing/topics'] = 'administration=write';
    world.github.deny['POST /repos/alice/existing/issues'] = 'issues=write';
    const missing = (await world.call('POST', 'github/check')).body;
    assert.equal(missing.ok, false);
    assert.equal(missing.message, 'Droits manquants : Administration, Issues.');
  } finally {
    await world.close();
  }
});

test('the token check explains a refused token or a missing token', async () => {
  const world = await startWorld({ env: { GITHUB_TOKEN: 'expired' } });
  try {
    const res = (await world.call('POST', 'github/check')).body;
    assert.equal(res.ok, false);
    assert.match(res.message, /Jeton GitHub refusé \(absent, expiré ou révoqué\)/);
  } finally {
    await world.close();
  }
  const none = await startWorld({ env: { GITHUB_TOKEN: '' } });
  try {
    assert.match((await none.call('POST', 'github/check')).body.message, /Aucun jeton/);
  } finally {
    await none.close();
  }
});
