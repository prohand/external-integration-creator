// -----------------------------------------------------------------------------
// Fake GitHub REST API, in memory. Enough of the API for the launch steps:
// repositories, template generation, contents, Git Data, settings, topics,
// labels, secrets, issues. `deny` simulates a missing token permission.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { startFake } from './server.js';

const TEMPLATE_DIR = new URL('../fixtures/template/', import.meta.url).pathname;

function readTree(dir, root = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) readTree(path, root, out);
    else out[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return out;
}

export const TEMPLATE_FILES = readTree(TEMPLATE_DIR);

const sha = (value) => createHash('sha1').update(String(value)).digest('hex');

export async function startFakeGitHub({ login = 'alice', ownerType = 'User', isTemplate = true } = {}) {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const repos = new Map();
  const commits = new Map(); // sha -> { files, parents }
  const trees = new Map(); // sha -> files
  const blobs = new Map(); // sha -> base64 content
  let issueCounter = 0;

  function addRepo(fullName, files, { template = false, branch = 'main' } = {}) {
    const treeSha = sha(JSON.stringify(files));
    trees.set(treeSha, { ...files });
    const commitSha = sha(`${fullName}:${treeSha}:${Math.random()}`);
    commits.set(commitSha, { tree: treeSha, parents: [] });
    const [owner, name] = fullName.split('/');
    const repo = {
      full_name: fullName,
      name,
      owner: { login: owner },
      html_url: `https://github.com/${fullName}`,
      default_branch: branch,
      is_template: template,
      private: false,
      refs: { [branch]: commitSha },
      settings: {},
      topics: [],
      labels: new Map(),
      secrets: {},
      security: {},
      subscribed: false,
      workflowPermissions: null,
      issues: [],
      comments: [],
      runs: [],
      pulls: [],
      dispatches: [],
      branchInfo: {},
    };
    repos.set(fullName.toLowerCase(), repo);
    return repo;
  }

  addRepo('GladysAssistant/integration-template-js', TEMPLATE_FILES, { template: isTemplate });

  const filesOf = (repo, ref = repo.default_branch) => {
    const commitSha = repo.refs[ref] ?? ref;
    const commit = commits.get(commitSha);
    return commit ? trees.get(commit.tree) : null;
  };

  const fake = {
    login,
    repos,
    deny: {}, // "METHOD /path" -> accepted permissions header (403)
    branchDelay: 0, // GET ref answers 404 this many times after creation
    keyPair,
    filesOf,
    addRepo,
  };

  let ids = 100;
  const now = () => new Date().toISOString();
  const repoOf = (full) => repos.get(full.toLowerCase());
  // --- helpers to script what Claude / the CI do in a repository
  fake.comment = (full, body, { bot = true, login: who = bot ? 'github-actions[bot]' : login } = {}) => {
    const repo = repoOf(full);
    const c = { id: ++ids, body, user: { login: who, type: bot ? 'Bot' : 'User' }, created_at: now(), updated_at: now(), html_url: `${repo.html_url}/issues/1#issuecomment-${ids}` };
    repo.comments.push(c);
    return c;
  };
  fake.addRun = (full, run) => {
    const repo = repoOf(full);
    const r = {
      id: ++ids,
      status: 'completed',
      conclusion: 'success',
      event: 'issues',
      created_at: now(),
      run_started_at: now(),
      updated_at: now(),
      jobs: [],
      ...run,
    };
    r.html_url = `${repo.html_url}/actions/runs/${r.id}`;
    r.jobs = r.jobs.map((j) => ({ id: ++ids, status: 'completed', html_url: `${r.html_url}/job/${ids}`, steps: [], ...j }));
    repo.runs.unshift(r);
    return r;
  };
  /** A commit on a branch (e.g. Claude's work merged on main). */
  fake.commitTo = (full, branch, files, message = 'Work') => {
    const repo = repoOf(full);
    const base = filesOf(repo, branch) ?? {};
    const treeSha = sha(JSON.stringify({ ...base, ...files }) + Math.random());
    trees.set(treeSha, { ...base, ...files });
    const commitSha = sha(`${treeSha}:${message}`);
    commits.set(commitSha, { tree: treeSha, parents: [repo.refs[branch]], message });
    repo.refs[branch] = commitSha;
    return commitSha;
  };
  // What the dispatched workflows do (overridable per test).
  fake.storeCheck = { conclusion: 'success', log: '2026-01-01T00:00:00.0000000Z [warning] docker_image: registry check skipped\n' };
  fake.release = { conclusion: 'success', bump: 'minor' };
  fake.onDispatch = (full, workflow, body) => {
    const repo = repoOf(full);
    if (workflow === 'store-check.yml') {
      const failed = fake.storeCheck.conclusion !== 'success';
      fake.addRun(full, {
        path: '.github/workflows/store-check.yml',
        event: 'workflow_dispatch',
        conclusion: fake.storeCheck.conclusion,
        jobs: [{ name: 'store-check', conclusion: fake.storeCheck.conclusion, log: fake.storeCheck.log, steps: [{ name: 'Store admission checks', conclusion: failed ? 'failure' : 'success' }] }],
      });
    }
    if (workflow === 'release.yml') {
      const files = filesOf(repo, body.ref);
      const manifest = JSON.parse(files['gladys-assistant-integration.json']);
      const [major, minor, patch] = manifest.version.split('.').map(Number);
      const version = fake.release.bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
      manifest.version = version;
      manifest.docker_image = manifest.docker_image.replace(/:[^:]+$/, `:${version}`);
      fake.commitTo(full, body.ref, { 'gladys-assistant-integration.json': `${JSON.stringify(manifest, null, 2)}\n` }, `chore(release): ${version}`);
      fake.lastReleaseVersion = version;
      const failed = fake.release.conclusion !== 'success';
      fake.addRun(full, {
        path: '.github/workflows/release.yml',
        event: 'workflow_dispatch',
        conclusion: fake.release.conclusion,
        jobs: [
          { name: 'prepare', conclusion: 'success' },
          { name: 'build / build', conclusion: failed ? 'failure' : 'success', steps: [{ name: 'Build and push', conclusion: failed ? 'failure' : 'success' }] },
        ],
      });
    }
  };

  fake.pushBranch = (full, branch, commits, files) => {
    const repo = repoOf(full);
    const list = commits.map((message, i) => ({ sha: sha(`${branch}:${message}:${i}`), message, date: new Date(Date.now() + i * 1000).toISOString() }));
    repo.branchInfo[branch] = { commits: list, files };
    repo.refs[branch] = list.at(-1).sha;
    return list;
  };

  const server = await startFake(async (req) => {
    const reply = await handle(req);
    // ETag on reads, 304 when unchanged (free in the real rate limit).
    if (req.method === 'GET' && reply && (reply.status ?? 200) === 200 && typeof reply.body === 'object') {
      const etag = `"${sha(JSON.stringify(reply.body))}"`;
      if (req.headers['if-none-match'] === etag) {
        fake.notModified = (fake.notModified ?? 0) + 1;
        return { status: 304, body: '' };
      }
      return { ...reply, headers: { ...reply.headers, etag } };
    }
    return reply;
  });

  function handle({ method, path, query, body, headers }) {
    const denied = fake.deny[`${method} ${path}`];
    if (denied) {
      return {
        status: 403,
        headers: { 'x-accepted-github-permissions': denied },
        body: { message: 'Resource not accessible by personal access token' },
      };
    }
    if (headers.authorization !== 'Bearer test-token' && method !== 'GET') {
      return { status: 401, body: { message: 'Bad credentials' } };
    }

    if (method === 'GET' && path === '/user' && headers.authorization !== 'Bearer test-token') {
      return { status: 401, body: { message: 'Bad credentials' } };
    }
    if (method === 'GET' && path === '/user') {
      return { body: { login }, headers: { 'github-authentication-token-expiration': '2027-02-25 10:00:00 UTC' } };
    }
    if (method === 'GET' && path === '/user/subscriptions') return { body: [] };
    const logPath = /^\/_logs\/([^/]+\/[^/]+)\/(\d+)$/.exec(path);
    if (logPath && method === 'GET') {
      const job = repoOf(logPath[1])?.runs.flatMap((r) => r.jobs).find((j) => j.id === Number(logPath[2]));
      return { body: job?.log ?? '' };
    }
    let list = /^\/(users|orgs)\/([^/]+)\/repos$/.exec(path);
    if (list && method === 'GET') {
      const owner = list[2].toLowerCase();
      return { body: [...repos.values()].filter((r) => r.owner.login.toLowerCase() === owner) };
    }
    let m = /^\/users\/([^/]+)$/.exec(path);
    if (m && method === 'GET') return { body: { login: m[1], type: m[1] === login ? 'User' : ownerType } };

    if ((m = /^\/(user|orgs\/[^/]+)\/repos$/.exec(path)) && method === 'POST') {
      const owner = m[1] === 'user' ? login : m[1].split('/')[1];
      const full = `${owner}/${body.name}`;
      if (repos.has(full.toLowerCase())) return { status: 422, body: { message: 'name already exists' } };
      const repo = addRepo(full, body.auto_init ? { 'README.md': `# ${body.name}\n` } : {});
      repo.createdDelay = fake.branchDelay;
      return { status: 201, body: repo };
    }

    m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return undefined;
    const full = `${m[1]}/${m[2]}`;
    const rest = m[3] ?? '';
    const repo = repos.get(full.toLowerCase());

    if (rest === '/generate' && method === 'POST') {
      if (!repo?.is_template) return { status: 422, body: { message: 'not a template' } };
      const target = `${body.owner}/${body.name}`;
      if (repos.has(target.toLowerCase())) return { status: 422, body: { message: 'name already exists' } };
      const created = addRepo(target, { ...filesOf(repo) }, { branch: repo.default_branch });
      created.createdDelay = fake.branchDelay;
      created.description = body.description;
      return { status: 201, body: created };
    }
    if (!repo) return { status: 404, body: { message: 'Not Found' } };

    if (rest === '' && method === 'GET') return { body: repo };
    if (rest === '' && method === 'PATCH') {
      Object.assign(repo.settings, body);
      return { body: repo };
    }

    if ((m = /^\/contents\/(.+)$/.exec(rest)) && method === 'GET') {
      const files = filesOf(repo, query.get('ref') ?? repo.default_branch);
      const file = files?.[decodeURIComponent(m[1])];
      if (file === undefined) return { status: 404, body: { message: 'Not Found' } };
      return { body: { encoding: 'base64', content: Buffer.from(file).toString('base64') } };
    }

    // --- Git Data
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      if (repo.createdDelay > 0) {
        repo.createdDelay -= 1;
        return { status: 404, body: { message: 'Not Found' } };
      }
      const head = repo.refs[decodeURIComponent(m[1])];
      return head ? { body: { object: { sha: head } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      const commit = commits.get(m[1]);
      return commit ? { body: { sha: m[1], tree: { sha: commit.tree } } } : { status: 404, body: {} };
    }
    if ((m = /^\/git\/trees\/(.+)$/.exec(rest)) && method === 'GET') {
      const files = filesOf(repo, m[1]);
      return {
        body: {
          truncated: false,
          tree: Object.entries(files).map(([p, content]) => {
            const s = sha(content);
            blobs.set(s, Buffer.from(content).toString('base64'));
            return { path: p, mode: '100644', type: 'blob', sha: s };
          }),
        },
      };
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      return { body: { content: blobs.get(m[1]), encoding: 'base64' } };
    }
    if (rest === '/git/refs' && method === 'POST') {
      if (!/^refs\/.+\/.+/.test(body.ref ?? '')) return { status: 422, body: { message: 'Reference name is invalid' } };
      repo.refs[body.ref.replace(/^refs\/heads\//, '')] = body.sha;
      return { status: 201, body: { ref: body.ref } };
    }
    if (/^\/actions\/runs\/\d+\/rerun$/.test(rest) && method === 'POST') {
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const s = sha(body.content);
      blobs.set(s, body.content);
      return { status: 201, body: { sha: s } };
    }
    if (rest === '/git/trees' && method === 'POST') {
      const base = body.base_tree ? trees.get(body.base_tree) : {};
      const files = { ...base };
      for (const entry of body.tree) {
        files[entry.path] =
          entry.content ?? Buffer.from(blobs.get(entry.sha) ?? '', 'base64').toString('utf8');
      }
      const s = sha(JSON.stringify(files));
      trees.set(s, files);
      return { status: 201, body: { sha: s } };
    }
    if (rest === '/git/commits' && method === 'POST') {
      const s = sha(`${body.tree}:${body.message}:${Math.random()}`);
      commits.set(s, { tree: body.tree, parents: body.parents, message: body.message });
      return { status: 201, body: { sha: s } };
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      repo.refs[decodeURIComponent(m[1])] = body.sha;
      return { body: { object: { sha: body.sha } } };
    }

    // --- settings
    if (['/vulnerability-alerts', '/automated-security-fixes', '/private-vulnerability-reporting'].includes(rest) && method === 'PUT') {
      repo.security[rest.slice(1)] = true;
      return { status: 204, body: '' };
    }
    if (rest === '/actions/permissions/workflow' && method === 'PUT') {
      repo.workflowPermissions = body;
      return { status: 204, body: '' };
    }
    if (rest === '/topics' && method === 'GET') return { body: { names: repo.topics } };
    if (rest === '/topics' && method === 'PUT') {
      if (body.names.some((n) => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(n))) {
        return { status: 422, body: { message: 'Invalid topic names' } };
      }
      repo.topics = body.names;
      return { body: { names: repo.topics } };
    }
    if (rest === '/subscription' && method === 'PUT') {
      repo.subscribed = body.subscribed;
      return { body: { subscribed: true } };
    }
    if (rest === '/labels' && method === 'POST') {
      if (repo.labels.has(body.name)) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] } };
      }
      repo.labels.set(body.name, body);
      return { status: 201, body };
    }
    if ((m = /^\/labels\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const name = decodeURIComponent(m[1]);
      repo.labels.set(name, { name, ...body });
      return { body: repo.labels.get(name) };
    }

    // --- secrets
    if (rest === '/actions/secrets/public-key' && method === 'GET') {
      return { body: { key_id: 'key-1', key: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL) } };
    }
    if ((m = /^\/actions\/secrets\/([A-Z_]+)$/.exec(rest)) && method === 'PUT') {
      repo.secrets[m[1]] = body;
      return { status: 201, body: '' };
    }

    // --- live development
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      if (method === 'GET') return { body: repo.comments };
      if (method === 'POST') return { status: 201, body: fake.comment(full, body.body, { bot: false }) };
    }
    if ((m = /^\/actions\/workflows\/([\w.-]+)\/runs$/.exec(rest)) && method === 'GET') {
      const runs = repo.runs.filter((r) => r.path === `.github/workflows/${m[1]}`);
      return { body: { total_count: runs.length, workflow_runs: runs.map(({ jobs, ...r }) => r) } };
    }
    if ((m = /^\/actions\/workflows\/([\w.-]+)\/dispatches$/.exec(rest)) && method === 'POST') {
      if (!['ci.yml', 'store-check.yml', 'release.yml'].includes(m[1])) return { status: 404, body: { message: 'Not Found' } };
      repo.dispatches.push({ workflow: m[1], ...body });
      fake.onDispatch(full, m[1], body);
      return { status: 204, body: '' };
    }
    if (rest === '/actions/runs' && method === 'GET') {
      const runs = repo.runs.filter((r) => !query.get('head_sha') || r.head_sha === query.get('head_sha'));
      return { body: { workflow_runs: runs.map(({ jobs, ...r }) => r) } };
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(rest)) && method === 'GET') {
      const run = repo.runs.find((r) => r.id === Number(m[1]));
      if (!run) return { status: 404, body: {} };
      const { jobs, ...view } = run;
      return { body: view };
    }
    if ((m = /^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(rest)) && method === 'POST') {
      const run = repo.runs.find((r) => r.id === Number(m[1]));
      run.conclusion = 'success';
      for (const job of run.jobs) {
        job.conclusion = 'success';
        for (const st of job.steps) st.conclusion = 'success';
      }
      fake.reruns = (fake.reruns ?? 0) + 1;
      return { status: 201, body: '' };
    }
    if (rest === '/commits' && method === 'GET') {
      const head = repo.refs[query.get('sha') ?? repo.default_branch];
      return { body: head ? [{ sha: head, commit: { message: commits.get(head)?.message ?? 'Initial commit' } }] : [] };
    }
    if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest)) && method === 'GET') {
      const run = repo.runs.find((r) => r.id === Number(m[1]));
      return run ? { body: { jobs: run.jobs.map(({ log, ...j }) => j) } } : { status: 404, body: {} };
    }
    if ((m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)) && method === 'GET') {
      // Like GitHub: a redirect to the log file.
      return { status: 302, headers: { location: `/_logs/${full}/${m[1]}` }, body: '' };
    }
    if (rest === '/pulls' && method === 'GET') {
      const state = query.get('state') ?? 'open';
      return { body: [...repo.pulls].reverse().filter((p) => state === 'all' || p.state === state) };
    }
    if (rest === '/pulls' && method === 'POST') {
      if (repo.pulls.some((p) => p.head.ref === body.head && p.state === 'open')) {
        return { status: 422, body: { message: 'A pull request already exists' } };
      }
      const number = repo.issues.length + repo.pulls.length + 1;
      const pr = {
        number,
        title: body.title,
        body: body.body,
        state: 'open',
        draft: false,
        merged_at: null,
        created_at: now(),
        head: { ref: body.head, sha: repo.refs[body.head] },
        base: { ref: body.base },
        html_url: `${repo.html_url}/pull/${number}`,
      };
      repo.pulls.push(pr);
      return { status: 201, body: pr };
    }
    if (rest === '/branches' && method === 'GET') return { body: Object.keys(repo.refs).map((name) => ({ name })) };
    if ((m = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest)) && method === 'GET') {
      const info = repo.branchInfo[decodeURIComponent(m[2])];
      if (!info) return { status: 404, body: { message: 'Not Found' } };
      return {
        body: {
          ahead_by: info.commits.length,
          commits: info.commits.map((c) => ({
            sha: c.sha,
            html_url: `${repo.html_url}/commit/${c.sha}`,
            commit: { message: c.message, author: { name: 'Claude', date: c.date } },
          })),
          files: info.files,
        },
      };
    }

    // --- issues
    if (rest === '/issues' && method === 'POST') {
      if (!body.title) return { status: 422, body: { message: 'Validation Failed' } };
      issueCounter += 1;
      const issue = { number: issueCounter, html_url: `${repo.html_url}/issues/${issueCounter}`, ...body };
      repo.issues.push(issue);
      return { status: 201, body: issue };
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest)) && method === 'GET') {
      const issue = repo.issues.find((i) => i.number === Number(m[1]));
      return issue ? { body: issue } : { status: 404, body: { message: 'Not Found' } };
    }
    return undefined;
  }

  return Object.assign(fake, server);
}

/** Opens a secret sealed by the app with the fake repository key. */
export function openSecret(fake, encrypted) {
  return sodium.to_string(
    sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      fake.keyPair.publicKey,
      fake.keyPair.privateKey,
    ),
  );
}
