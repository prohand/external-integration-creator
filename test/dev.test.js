import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUsageLimit, parseTrackingComment } from '../src/live/dev.js';
import { FORM, startWorld } from './world.js';

const REPO = 'alice/gladys-oral-b';
const BRANCH = 'claude/issue-1-20261127-2300';
const TRACKING = `**Claude is working…** <img src="https://github.com/x.gif" width="14px" />

[View job](https://github.com/${REPO}/actions/runs/1) • [\`${BRANCH}\`](https://github.com/${REPO}/tree/${encodeURIComponent(BRANCH)}) • [Create PR ➔](https://github.com/${REPO}/compare/main...${BRANCH}?quick_pull=1)

---
### Todo List
- [x] Lire CLAUDE.md et le cahier des charges
- [x] Écrire le client Bluetooth
- [ ] Ajouter les tests
`;

test('Claude’s tracking comment becomes a checklist', () => {
  const plan = parseTrackingComment(TRACKING);
  assert.equal(plan.state, 'working');
  assert.deepEqual(plan.items, [
    { done: true, text: 'Lire CLAUDE.md et le cahier des charges' },
    { done: true, text: 'Écrire le client Bluetooth' },
    { done: false, text: 'Ajouter les tests' },
  ]);
  assert.equal(plan.done, 2);
  assert.equal(plan.total, 3);
  assert.equal(plan.branch, BRANCH);
  assert.match(plan.createPrUrl, /quick_pull=1/);
  assert.equal(parseTrackingComment('**Claude finished @alice’s task in 2m 3s**').state, 'finished');
  assert.equal(parseTrackingComment('**Claude encountered an error after 45s**').state, 'error');
  assert.equal(parseTrackingComment('@claude please'), null);
});

test('subscription limits are recognized in the logs', () => {
  assert.deepEqual(detectUsageLimit('… Claude AI usage limit reached|1764280800 …'), { resetAt: '2025-11-27T22:00:00.000Z' });
  assert.deepEqual(detectUsageLimit('Error: 5-hour limit reached ∙ resets 3pm'), { resetAt: null });
  assert.equal(detectUsageLimit('npm test failed'), null);
});

async function launched(world) {
  await world.call('PUT', 'settings', { claudeToken: 'sk-ant-oat01-x' });
  const { body } = await world.call('POST', 'launches', { ...FORM, simulate: false });
  await world.settle(body.id);
  return body.id;
}

test('the development tab shows the plan, the run, the commits and starts the CI', async () => {
  const world = await startWorld();
  try {
    const id = await launched(world);
    const gh = world.github;
    gh.comment(REPO, '@claude Développe cette intégration', { bot: false });
    gh.comment(REPO, TRACKING);
    gh.addRun(REPO, {
      path: '.github/workflows/claude.yml',
      status: 'in_progress',
      conclusion: null,
      jobs: [{ name: 'claude', steps: [{ name: 'Checkout', status: 'completed', conclusion: 'success' }, { name: 'Claude Code', status: 'in_progress' }] }],
    });
    const [, second] = gh.pushBranch(REPO, BRANCH, ['Add Bluetooth client', 'Add device mapping'], [
      { filename: 'src/oralb.js', status: 'added', additions: 120, deletions: 0 },
      { filename: 'index.js', status: 'modified', additions: 8, deletions: 3 },
    ]);

    const snap = (await world.call('GET', `launches/${id}/dev`)).body;
    assert.equal(snap.plan.done, 2);
    assert.equal(snap.plan.total, 3);
    assert.equal(snap.claudeRun.status, 'in_progress');
    assert.deepEqual(snap.claudeRun.steps.map((s) => s.name), ['Checkout', 'Claude Code']);
    assert.equal(snap.branch, BRANCH);
    assert.deepEqual(snap.commits.map((c) => c.message), ['Add device mapping', 'Add Bluetooth client']);
    assert.deepEqual(snap.totals, { additions: 128, deletions: 3 });
    assert.equal(snap.pr, null);
    assert.ok(snap.activity.some((a) => a.kind === 'message' && /Développe/.test(a.text)));
    assert.ok(snap.activity.some((a) => a.text === 'Claude a démarré'));

    // No CI for Claude's commit (pushed with GITHUB_TOKEN): the app starts it, once.
    assert.equal(snap.ci.status, 'requested');
    const repo = gh.repos.get(REPO);
    assert.deepEqual(repo.dispatches, [{ workflow: 'ci.yml', ref: BRANCH }]);
    await world.app.monitor.poll(id);
    assert.equal(repo.dispatches.length, 1, 'not twice for the same commit');

    // The CI result shows up, failing tests raise an alert.
    gh.addRun(REPO, {
      path: '.github/workflows/ci.yml',
      head_sha: second.sha,
      conclusion: 'failure',
      jobs: [{ name: 'Lint & test (Node 22)', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }],
    });
    const failing = await world.app.monitor.poll(id);
    assert.equal(failing.ci.conclusion, 'failure');
    assert.deepEqual(failing.alerts.map((a) => a.kind), ['tests']);
    assert.match(failing.alerts[0].message, /Lint & test \(Node 22\) → Run tests/);

    // "Relancer Claude" explains the failing CI to Claude.
    const retry = await world.call('POST', `launches/${id}/dev/retry`);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const last = repo.comments.at(-1);
    assert.match(last.body, /^@claude La CI échoue sur ta branche/);
    assert.equal(last.user.type, 'User', 'posted with the user token: the workflow accepts it');

    // Unchanged data is served from 304 answers.
    await world.app.monitor.poll(id);
    assert.ok(gh.notModified > 0);
  } finally {
    await world.close();
  }
});

test('a subscription limit is shown clearly, with its reset time', async () => {
  const world = await startWorld();
  try {
    const id = await launched(world);
    world.github.addRun(REPO, {
      path: '.github/workflows/claude.yml',
      conclusion: 'failure',
      jobs: [{ name: 'claude', conclusion: 'failure', log: 'Run anthropics/claude-code-action@v1\nClaude AI usage limit reached|1764280800\n' }],
    });
    const snap = (await world.call('GET', `launches/${id}/dev`)).body;
    assert.equal(snap.alerts[0].kind, 'limit');
    assert.equal(snap.alerts[0].resetAt, '2025-11-27T22:00:00.000Z');
    assert.match(snap.alerts[0].message, /Limite d’abonnement Claude atteinte/);
    await world.call('POST', `launches/${id}/dev/retry`);
    assert.match(world.github.repos.get(REPO).comments.at(-1).body, /^@claude Reprends le travail/);
  } finally {
    await world.close();
  }
});

test('messages to Claude are posted in the issue, prefixed with @claude', async () => {
  const world = await startWorld();
  try {
    const id = await launched(world);
    const res = await world.call('POST', `launches/${id}/dev/message`, { text: 'Ajoute des tests' });
    assert.equal(res.status, 200);
    assert.equal(world.github.repos.get(REPO).comments.at(-1).body, '@claude Ajoute des tests');
    await world.call('POST', `launches/${id}/dev/message`, { text: '@claude Fais plus simple' });
    assert.equal(world.github.repos.get(REPO).comments.at(-1).body, '@claude Fais plus simple');
    assert.equal((await world.call('POST', `launches/${id}/dev/message`, { text: ' ' })).status, 400);
  } finally {
    await world.close();
  }
});

test('the pull request is opened with the user token, once', async () => {
  const world = await startWorld();
  try {
    const id = await launched(world);
    assert.equal((await world.call('POST', `launches/${id}/dev/pr`)).status, 409, 'no branch yet');
    world.github.pushBranch(REPO, BRANCH, ['Add client'], []);
    const opened = await world.call('POST', `launches/${id}/dev/pr`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const [pr] = world.github.repos.get(REPO).pulls;
    assert.equal(pr.head.ref, BRANCH);
    assert.equal(pr.base.ref, 'main');
    assert.match(pr.body, /^Closes #1/);
    const again = (await world.call('POST', `launches/${id}/dev/pr`)).body;
    assert.equal(again.existing, true);
    const snap = await world.app.monitor.poll(id);
    assert.equal(snap.pr.state, 'open');
    assert.equal(snap.pr.diffUrl, `${pr.html_url}/files`);
  } finally {
    await world.close();
  }
});

test('GitHub is polled only while a development page is open', async () => {
  const world = await startWorld({ env: { DEV_POLL_SECONDS: '0.05' } });
  try {
    const id = await launched(world);
    const before = world.github.requests.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(world.github.requests.length, before, 'nothing without an open page');

    const controller = new AbortController();
    const res = await fetch(`${world.app.base}/api/launches/${id}/dev/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('event: dev\n')) text += new TextDecoder().decode((await reader.read()).value);
    assert.ok(world.app.monitor.timers.has(id));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(world.github.requests.length > before + 5, 'polled while open');

    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(world.app.monitor.timers.size, 0, 'stopped when the page is closed');
  } finally {
    await world.close();
  }
});

test('simulations have no development to follow', async () => {
  const world = await startWorld();
  try {
    const { body } = await world.call('POST', 'launches', FORM);
    await world.settle(body.id);
    assert.equal((await world.call('GET', `launches/${body.id}/dev`)).body.simulated, true);
    assert.equal((await world.call('POST', `launches/${body.id}/dev/message`, { text: 'Bonjour' })).status, 409);
  } finally {
    await world.close();
  }
});
