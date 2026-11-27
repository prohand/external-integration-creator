// -----------------------------------------------------------------------------
// Application: wires the configuration, the storage, the sources and the
// routes into one node:http server.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Cache } from './cache.js';
import { STORE_CATEGORIES } from './categories.js';
import { GitHub } from './github.js';
import { log, registerSecret } from './log.js';
import { defaultRepoName } from './names.js';
import { checkName } from './launch/checks.js';
import { KEYWORDS_MIN_GLADYS, dockerImage } from './launch/files.js';
import { Runner, channelOf } from './launch/runner.js';
import { OPTIONS, STEPS } from './launch/steps.js';
import { validateLaunch } from './launch/validate.js';
import {
  currentUser,
  finishUserApiKey,
  listCategories,
  revokeUserApiKey,
  searchIntegrationTopics,
  startUserApiKey,
} from './sources/forum.js';
import { fetchStoreIndex } from './sources/store.js';
import { buildBoard, fetchTracker } from './sources/tracker.js';
import { loadRepoSettings, publicSettings, saveSettings } from './settings.js';
import { Hub } from './sse.js';
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
export const APP_VERSION = '0.2.0';

// Real launches (creating things on GitHub / the forum) are enabled in phase 3.
export const REAL_LAUNCH_READY = false;

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

/** "A long sentence…" cut at a word boundary to fit `max` characters. */
function shorten(text, max = 100) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:.]+$/, '')}…`;
}

export function createApp({ config, db, hub = new Hub() }) {
  const cache = new Cache(config.cacheTtlMs);
  const shortCache = new Cache(60_000);
  const checkAuth = createBasicAuth({ user: config.appUser, password: config.appPassword });
  const router = new Router();
  const github = new GitHub({ apiUrl: config.githubApiUrl, token: config.githubToken, timeoutMs: config.httpTimeoutMs });

  const sources = {
    tracker: (opts) => cache.get('tracker', () => fetchTracker(config), opts),
    store: (opts) => cache.get('store', () => fetchStoreIndex(config), opts),
    forum: (term) =>
      shortCache.get(`forum:${term.toLowerCase()}`, () => searchIntegrationTopics(config, term)),
  };

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
  router.put('/api/settings', async ({ body }) => {
    const result = await saveSettings(db, body ?? {});
    shortCache.clear('github:user');
    return result;
  });

  // --- forum account (Discourse User API Key, copy/paste: no callback URL) ---
  router.get('/api/forum/categories', async () => {
    const { value } = await cache.get('forum:categories', () => listCategories(config));
    return { categories: value, defaultId: loadRepoSettings().forum?.category_id ?? null };
  });

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

  router.get('/api/prefill', async ({ query }) => {
    const key = query.get('idea') ?? '';
    const { board: b } = await board();
    const idea = Object.values(b.columns)
      .flat()
      .find((i) => i.key === key);
    const name = idea?.name ?? '';
    const owner = await resolveOwner();
    return {
      idea: idea ? card(idea) : null,
      displayName: name,
      repoName: name ? defaultRepoName(name) : '',
      owner,
      categories: idea?.categories ?? [],
      description: { fr: '', en: idea?.description ? shorten(idea.description) : '', de: '', es: '' },
      keywords: name ? [name.toLowerCase()] : [],
    };
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

  router.post('/api/launches', async ({ body }) => {
    const request = validateLaunch(body ?? {});
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
  });

  router.get('/api/launches/:id', ({ params }) => runner.view(runner.find(params.id)));

  router.get('/api/launches/:id/events', ({ req, res, params }) => {
    const integ = runner.view(runner.find(params.id));
    hub.open(req, res, channelOf(params.id), [{ event: 'launch', data: integ }]);
  });

  router.post('/api/launches/:id/steps/:step/retry', ({ params }) => {
    runner.retry(params.id, params.step);
    return runner.view(runner.find(params.id));
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
  server.on('close', () => hub.closeAll());

  return { server, router, cache, sources, dashboard, runner, hub, github };
}
