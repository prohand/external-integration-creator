// -----------------------------------------------------------------------------
// Application: wires the configuration, the storage, the sources and the
// routes into one node:http server.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Cache } from './cache.js';
import { STORE_CATEGORIES } from './categories.js';
import { GitHub } from './github.js';
import { checkToken } from './github-check.js';
import { log, registerSecret } from './log.js';
import { checkName } from './launch/checks.js';
import { KEYWORDS_MIN_GLADYS, dockerImage } from './launch/files.js';
import { Runner, channelOf } from './launch/runner.js';
import { OPTIONS, STEPS } from './launch/steps.js';
import { validateLaunch } from './launch/validate.js';
import { autofillFromIdea } from './launch/autofill.js';
import {
  createPost,
  currentUser,
  finishUserApiKey,
  revokeUserApiKey,
  searchIntegrationTopics,
  searchTopicMentions,
  startUserApiKey,
} from './sources/forum.js';
import { reserveBatchMessage } from './launch/texts.js';
import { fetchStoreIndex } from './sources/store.js';
import { buildBoard, fetchTracker } from './sources/tracker.js';
import { loadRepoSettings, publicSettings, saveSettings } from './settings.js';
import { Hub } from './sse.js';
import { DevMonitor, devChannel } from './live/monitor.js';
import {
  ApiError,
  Router,
  clientInfo,
  createBasicAuth,
  readJsonBody,
  send,
  serveStatic,
} from './web.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
export const APP_VERSION = '0.4.0';

// Real launches (creating things on GitHub) can be switched off here.
export const REAL_LAUNCH_READY = true;

// Slim card for the browser: only what the dashboard shows.
function card(item) {
  return {
    key: item.key,
    id: item.id ?? null,
    name: item.name,
    status: item.status,
    unknownStatus: item.unknownStatus || undefined,
    reservedLocally: item.reservedLocally || undefined,
    prio: item.prio || undefined,
    categories: item.categories,
    rawCategory: item.rawCategory || undefined,
    access: item.access || undefined,
    noHardware: item.noHardware || undefined,
    docUrl: item.docUrl || undefined,
    repo: item.repo || undefined,
    author: item.author || undefined,
    gladysName: item.gladysName || undefined,
    description: item.description || undefined,
    installs: item.installs || undefined,
    notes: item.notes?.length ? item.notes : undefined,
    source: item.source,
  };
}

export function createApp({ config, db, hub = new Hub() }) {
  const cache = new Cache(config.cacheTtlMs);
  const shortCache = new Cache(60_000);
  const checkAuth = createBasicAuth({ user: config.appUser, password: config.appPassword });
  const router = new Router();
  const github = new GitHub({ apiUrl: config.githubApiUrl, token: config.githubToken, timeoutMs: config.httpTimeoutMs });
  // Live follow-up: conditional GETs (304 answers are free in the rate limit).
  const devGithub = new GitHub({
    apiUrl: config.githubApiUrl,
    token: config.githubToken,
    timeoutMs: config.httpTimeoutMs,
    etags: true,
  });

  const sources = {
    tracker: (opts) => cache.get('tracker', () => fetchTracker(config), opts),
    store: (opts) => cache.get('store', () => fetchStoreIndex(config), opts),
    forum: (term) =>
      shortCache.get(`forum:${term.toLowerCase()}`, () => searchIntegrationTopics(config, term)),
    mentions: (term) =>
      shortCache.get(`mentions:${term.toLowerCase()}`, () =>
        searchTopicMentions(config, forumTopicId(), term),
      ),
  };

  /** Community topic where launches are announced in batches. */
  function forumTopicId() {
    return loadRepoSettings().forum?.topic_id ?? 10385;
  }

  async function board(opts) {
    const result = await sources.tracker(opts);
    return { result, board: buildBoard(result.value, db.read().reservations) };
  }

  async function dashboard({ force = false } = {}) {
    const { result, board: b } = await board({ force });
    if (force) sources.store({ force: true }).catch(() => {});
    const columns = {};
    for (const [name, items] of Object.entries(b.columns)) columns[name] = items.map(card);
    return {
      fetchedAt: new Date(result.fetchedAt).toISOString(),
      stale: result.stale,
      warning: result.error ? `Données en cache : ${result.error.message}` : null,
      counts: b.counts,
      columns,
    };
  }

  /** Target account: the setting, else the owner of the GitHub token. */
  async function resolveOwner() {
    const configured = db.read().settings.owner;
    if (configured) return configured;
    if (!config.githubToken) return null;
    try {
      const { value } = await shortCache.get('github:user', () => github.get('/user'));
      return value.login;
    } catch {
      return null;
    }
  }

  const checkDeps = {
    board: async () => (await board()).board,
    storeIndex: async () => (await sources.store()).value,
    forumSearch: async (term) => (await sources.forum(term)).value,
    forumMentions: async (term) => (await sources.mentions(term)).value,
    github,
  };

  const runner = new Runner({
    db,
    hub,
    context: async (integ, addLine) => {
      const state = db.read();
      return {
        integ,
        dryRun: Boolean(integ.simulate),
        gh: new GitHub({
          apiUrl: config.githubApiUrl,
          token: config.githubToken,
          timeoutMs: config.httpTimeoutMs,
          dryRun: Boolean(integ.simulate),
          onSimulated: ({ method, path }) => addLine(`Simulation : ${method} ${path}`),
        }),
        config,
        settings: { ...state.settings },
        secrets: { ...state.secrets },
        repoSettings: loadRepoSettings(),
        deps: checkDeps,
        template: config.template,
        log: addLine,
        db,
      };
    },
  });

  const monitor = new DevMonitor({
    hub,
    gh: devGithub,
    intervalMs: config.devPollMs,
    findInteg: (id) => db.read().integrations.find((i) => i.id === id) ?? null,
  });

  /** A launched (not simulated) integration with its tracking issue. */
  function realInteg(id, { needIssue = true } = {}) {
    const integ = runner.find(id);
    if (integ.simulate) throw new ApiError(409, 'Simulation : il n’y a pas de développement réel à suivre.');
    if (needIssue && !integ.issueNumber) throw new ApiError(409, 'Pas d’issue de suivi pour cette intégration.');
    return integ;
  }

  async function postClaudeMessage(integ, text) {
    const clean = String(text ?? '').trim();
    if (clean.length < 2 || clean.length > 5000) throw new ApiError(400, 'Message vide ou trop long (5000 caractères au plus).');
    const body = /^@claude\b/i.test(clean) ? clean : `@claude ${clean}`;
    if (config.dryRun) return { simulated: true, body };
    const { data } = await github.post(`/repos/${integ.owner}/${integ.repoName}/issues/${integ.issueNumber}/comments`, { body });
    monitor.soon(integ.id);
    return { url: data.html_url, body };
  }

  // --- routes -------------------------------------------------------------------

  router.get('/api/status', async () => {
    const state = db.read();
    return {
      version: APP_VERSION,
      dryRun: config.dryRun,
      realLaunch: REAL_LAUNCH_READY,
      githubTokenSet: Boolean(config.githubToken),
      owner: await resolveOwner(),
      claudeTokenSet: Boolean(state.secrets.claudeToken),
      forumReady: Boolean(state.secrets.forumUserApiKey),
      cacheMinutes: config.cacheTtlMs / 60_000,
      categories: STORE_CATEGORIES,
      options: OPTIONS,
      steps: STEPS.map((s) => ({ id: s.id, title: s.title, essential: Boolean(s.essential), option: s.option ?? null })),
      keywordsMinGladys: KEYWORDS_MIN_GLADYS,
    };
  });

  router.get('/api/dashboard', () => dashboard());
  // Forces a new download; the previous data stays available if it fails.
  router.post('/api/refresh', () => dashboard({ force: true }));

  router.get('/api/settings', () => publicSettings(db.read()));

  // Probes the token rights without changing anything (see github-check.js).
  router.post('/api/github/check', async () => {
    shortCache.clear('github:user');
    return checkToken(github, { owner: db.read().settings.owner || null });
  });
  router.put('/api/settings', async ({ body }) => {
    const result = await saveSettings(db, body ?? {});
    shortCache.clear('github:user');
    return result;
  });

  // --- forum account (Discourse User API Key, copy/paste: no callback URL) ---
  router.post('/api/forum/connect', async () => {
    const { pending, url } = startUserApiKey(config);
    await db.update((s) => {
      s.secrets.forumPending = pending;
    });
    return { url };
  });

  router.post('/api/forum/complete', async ({ body }) => {
    const pending = db.read().secrets.forumPending;
    if (!pending) throw new ApiError(409, 'Aucune connexion en cours : cliquez d’abord sur « Ouvrir le forum ».');
    let key;
    try {
      key = finishUserApiKey(pending, body?.payload);
    } catch (err) {
      throw new ApiError(400, err.message);
    }
    registerSecret(key);
    const username = await currentUser(config, { key, clientId: pending.clientId });
    await db.update((s) => {
      s.secrets.forumUserApiKey = key;
      s.secrets.forumClientId = pending.clientId;
      delete s.secrets.forumPending;
      s.settings.forumUsername = username ?? '';
    });
    return publicSettings(db.read());
  });

  router.post('/api/forum/disconnect', async () => {
    const { secrets } = db.read();
    if (secrets.forumUserApiKey) {
      await revokeUserApiKey(config, { key: secrets.forumUserApiKey, clientId: secrets.forumClientId }).catch(
        (err) => log.warn(`Révocation de la clé du forum impossible : ${err.message}`),
      );
    }
    await db.update((s) => {
      delete s.secrets.forumUserApiKey;
      delete s.secrets.forumClientId;
      delete s.secrets.forumPending;
      s.settings.forumUsername = '';
    });
    return publicSettings(db.read());
  });

  // --- batched announcements ("Je prends :") in the community topic ---
  const pendingAnnouncements = (state) =>
    state.integrations.filter((i) => !i.simulate && i.forum?.queuedAt && !i.forum?.announced);

  router.get('/api/forum/batch', () => {
    const state = db.read();
    const pending = pendingAnnouncements(state);
    return {
      pending: pending.map((i) => ({ id: i.id, displayName: i.displayName, repo: `${i.owner}/${i.repoName}` })),
      message: pending.length ? reserveBatchMessage(pending) : '',
      topicUrl: `${config.forumUrl}/t/${forumTopicId()}`,
      connected: Boolean(state.secrets.forumUserApiKey),
      dryRun: config.dryRun,
    };
  });

  router.post('/api/forum/batch', async ({ body }) => {
    const state = db.read();
    const pending = pendingAnnouncements(state);
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const chosen = pending.filter((i) => ids.includes(i.id));
    if (!chosen.length) throw new ApiError(400, 'Aucune intégration à annoncer.');
    const raw = String(body?.raw ?? '').trim();
    if (raw.length < 10 || raw.length > 20_000) throw new ApiError(400, 'Message vide ou trop long.');
    if (!state.secrets.forumUserApiKey) throw new ApiError(400, 'Connectez d’abord votre compte du forum (Réglages).');
    if (config.dryRun) return { simulated: true, count: chosen.length };

    const post = await createPost(
      config,
      { key: state.secrets.forumUserApiKey, clientId: state.secrets.forumClientId },
      { topicId: forumTopicId(), raw },
    );
    const announced = { postNumber: post.postNumber, url: post.url, at: new Date().toISOString() };
    await db.update((s) => {
      for (const integ of s.integrations) {
        if (chosen.some((c) => c.id === integ.id)) {
          integ.forum = { ...integ.forum, announced };
          integ.links = { ...integ.links, forum: post.url };
        }
      }
    });
    shortCache.clear();
    return { ...announced, count: chosen.length };
  });

  async function findIdea(key) {
    const { board: b } = await board();
    return Object.values(b.columns)
      .flat()
      .find((i) => i.key === key);
  }

  router.get('/api/prefill', async ({ query }) => {
    const idea = await findIdea(query.get('idea') ?? '');
    const owner = await resolveOwner();
    const filled = idea
      ? autofillFromIdea(idea)
      : { displayName: '', repoName: '', categories: [], description: { fr: '', en: '', de: '', es: '' }, keywords: [], spec: '' };
    return { ...filled, idea: idea ? card(idea) : null, owner };
  });

  router.get('/api/check-name', async ({ query }) => {
    const displayName = String(query.get('displayName') ?? '').trim();
    const repoName = String(query.get('repoName') ?? '').trim();
    if (!displayName && !repoName) throw new ApiError(400, 'Nom manquant.');
    const owner = await resolveOwner();
    const report = await checkName({ displayName, repoName, owner, ideaKey: query.get('ideaKey') }, checkDeps);
    return {
      ...report,
      owner,
      repoUrl: owner ? `https://github.com/${owner}/${repoName}` : null,
      image: owner ? dockerImage(owner, repoName, '1.0.0') : null,
    };
  });

  router.get('/api/launches', () =>
    db
      .read()
      .integrations.map((i) => runner.view(i))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ steps, ...rest }) => rest),
  );

  // One click: everything filled from the tracker idea.
  router.post('/api/launches/quick', async ({ body }) => {
    const idea = await findIdea(String(body?.ideaKey ?? ''));
    if (!idea) throw new ApiError(404, 'Idée introuvable dans le tracker.');
    if (idea.bucket !== 'free') throw new ApiError(409, `« ${idea.name} » n’est plus libre (${idea.status}).`);
    return startLaunch(validateLaunch({ ...autofillFromIdea(idea), simulate: body?.simulate === true }));
  });

  router.post('/api/launches', ({ body }) => startLaunch(validateLaunch(body ?? {})));

  async function startLaunch(request) {
    const simulate = config.dryRun || request.simulate;
    if (!simulate && !REAL_LAUNCH_READY) {
      throw new ApiError(501, 'Le lancement réel arrive à la phase 3 : cochez « Simulation » pour l’instant.');
    }
    if (!simulate && !config.githubToken) throw new ApiError(400, 'Aucun jeton GitHub réglé (GITHUB_TOKEN).');
    const owner = (await resolveOwner()) ?? (simulate ? 'votre-compte' : null);
    if (!owner) throw new ApiError(400, 'Réglez le compte ou l’organisation GitHub cible (page Réglages).');

    const state = db.read();
    const clash = state.integrations.find(
      (i) => !i.simulate && !simulate && i.owner.toLowerCase() === owner.toLowerCase() && i.repoName.toLowerCase() === request.repoName.toLowerCase(),
    );
    if (clash) throw new ApiError(409, `Ce dépôt a déjà été lancé depuis cette appli (${clash.displayName}).`);

    const repoSettings = loadRepoSettings();
    const integ = await runner.create({
      ...request,
      simulate,
      owner,
      claude: request.actions.claude && Boolean(state.secrets.claudeToken),
      maxTurns: state.settings.claudeMaxTurns ?? repoSettings.claude?.max_turns ?? 40,
    });
    runner.start(integ.id);
    return runner.view(runner.find(integ.id));
  }

  router.get('/api/launches/:id', ({ params }) => runner.view(runner.find(params.id)));

  router.get('/api/launches/:id/events', ({ req, res, params }) => {
    const integ = runner.view(runner.find(params.id));
    hub.open(req, res, channelOf(params.id), [{ event: 'launch', data: integ }]);
  });

  router.post('/api/launches/:id/steps/:step/retry', ({ params }) => {
    runner.retry(params.id, params.step);
    return runner.view(runner.find(params.id));
  });

  // --- live development follow-up ---
  router.get('/api/launches/:id/dev', ({ params }) => monitor.latest(runner.find(params.id).id));

  router.get('/api/launches/:id/dev/events', ({ req, res, params }) => {
    const id = runner.find(params.id).id;
    const last = monitor.last.get(id)?.snap;
    hub.open(req, res, devChannel(id), last ? [{ event: 'dev', data: last }] : []);
  });

  router.post('/api/launches/:id/dev/message', ({ params, body }) =>
    postClaudeMessage(realInteg(params.id), body?.text),
  );

  // "Relancer Claude": a message adapted to what went wrong.
  router.post('/api/launches/:id/dev/retry', async ({ params }) => {
    const integ = realInteg(params.id);
    const snap = await monitor.latest(integ.id);
    const tests = snap?.alerts?.find((a) => a.kind === 'tests');
    const text = tests
      ? `La CI échoue sur ta branche (${tests.url}) : ${tests.message} Corrige le problème, relance npm test, npm run lint et npm run format:check, puis pousse.`
      : 'Reprends le travail là où tu t’es arrêté (la dernière exécution s’est arrêtée avant la fin).';
    return postClaudeMessage(integ, text);
  });

  // Opens the pull request of Claude's branch with the user's token (its CI then runs).
  router.post('/api/launches/:id/dev/pr', async ({ params }) => {
    const integ = realInteg(params.id, { needIssue: false });
    const snap = await monitor.poll(integ.id);
    if (!snap?.branch) throw new ApiError(409, 'Aucune branche de travail trouvée.');
    if (snap.pr && snap.pr.state === 'open') return { url: snap.pr.url, number: snap.pr.number, existing: true };
    if (config.dryRun) return { simulated: true };
    const { data } = await github.post(`/repos/${integ.owner}/${integ.repoName}/pulls`, {
      title: `${integ.displayName} : première version`,
      head: snap.branch,
      base: integ.defaultBranch || 'main',
      body: `${integ.issueNumber ? `Closes #${integ.issueNumber}\n\n` : ''}Pull request ouverte par External Integration Creator.`,
    });
    monitor.soon(integ.id, 1000);
    return { url: data.html_url, number: data.number };
  });

  router.delete('/api/launches/:id', async ({ params }) => {
    const integ = runner.find(params.id);
    if (runner.active.has(integ.id)) throw new ApiError(409, 'Lancement en cours : attendez la fin.');
    if (!integ.simulate && integ.repoCreated) {
      throw new ApiError(409, 'Le dépôt existe sur GitHub : cette intégration ne peut pas être oubliée ici.');
    }
    await db.update((state) => {
      state.integrations = state.integrations.filter((i) => i.id !== integ.id);
      state.reservations = state.reservations.filter((r) => r.integrationId !== integ.id);
    });
    return { ok: true };
  });

  // --- HTTP -----------------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    let path = url.pathname;
    const client = clientInfo(req, config.trustProxy);

    // Health check: always answered, without auth or base path (Docker).
    if (path === '/healthz') return send(req, res, 200, { ok: true });

    if (config.basePath) {
      if (path === config.basePath) {
        res.writeHead(301, { location: `${config.basePath}/${url.search}` });
        return res.end();
      }
      if (!path.startsWith(`${config.basePath}/`)) return send(req, res, 404, { error: 'Introuvable' });
      path = path.slice(config.basePath.length);
    }

    const auth = checkAuth(req, client.ip);
    if (!auth.ok) {
      if (auth.status === 401 && req.headers.authorization) log.warn('Authentification refusée', { ip: client.ip });
      return send(
        req,
        res,
        auth.status,
        { error: auth.status === 429 ? 'Trop de tentatives, réessayez plus tard.' : 'Authentification requise.' },
        auth.status === 401 ? { 'www-authenticate': 'Basic realm="External Integration Creator", charset="UTF-8"' } : {},
      );
    }

    if (path.startsWith('/api/')) {
      // Requests that change something must come from the app itself
      // (custom header = no cross-site form, no simple CORS request).
      if (!['GET', 'HEAD'].includes(req.method)) {
        const site = req.headers['sec-fetch-site'];
        if (req.headers['x-requested-with'] !== 'integration-creator' || site === 'cross-site') {
          return send(req, res, 403, { error: 'Requête refusée.' });
        }
      }
      const found = router.match(req.method === 'HEAD' ? 'GET' : req.method, path);
      if (!found) return send(req, res, 404, { error: 'Introuvable' });
      if (found.methodNotAllowed) return send(req, res, 405, { error: 'Méthode non autorisée' });
      try {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : undefined;
        const result = await found.handler({ req, res, params: found.params, query: url.searchParams, body, client });
        if (result !== undefined && !res.headersSent) send(req, res, 200, result);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 502;
        if (!(err instanceof ApiError)) log.error(`${req.method} ${path} a échoué`, { error: err.message });
        if (!res.headersSent) send(req, res, status, { error: err.message, details: err.details });
        else res.end();
      }
      return undefined;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, PUBLIC_DIR, path, config.basePath)) return undefined;
    }
    return send(req, res, 404, { error: 'Introuvable' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('Erreur inattendue', { error: err.message });
      if (!res.headersSent) send(req, res, 500, { error: 'Erreur interne' });
    });
  });
  // SSE connections stay open: keep Node's default timeouts out of their way.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.on('close', () => {
    monitor.stopAll();
    hub.closeAll();
  });

  return { server, router, cache, sources, dashboard, runner, hub, github, monitor };
}
