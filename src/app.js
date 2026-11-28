// -----------------------------------------------------------------------------
// Application: wires the configuration, the storage, the sources and the
// routes into one node:http server.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
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
import { releaseBatchMessage, reserveBatchMessage } from './launch/texts.js';
import { PUBLISH_STEPS } from './publish/steps.js';
import { fetchStoreIndex } from './sources/store.js';
import { buildBoard, fetchTracker } from './sources/tracker.js';
import { loadRepoSettings, publicSettings, saveSettings } from './settings.js';
import { Hub } from './sse.js';
import { DevMonitor, devChannel } from './live/monitor.js';
import { AuthService, roleRank } from './auth/service.js';
import { registerAuthRoutes } from './auth/routes.js';
import {
  ApiError,
  Router,
  clientInfo,
  hostName,
  isHostAllowed,
  readJsonBody,
  send,
  serveStatic,
} from './web.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
// Single source of the version: package.json (bumped by the Release workflow).
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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
  const auth = new AuthService({ config, db });
  const router = new Router();
  // The token set on the web page (Réglages) wins over GITHUB_TOKEN in .env.
  const githubToken = () => db.state.secrets?.githubToken || config.githubToken || '';
  // Claude: the personal token of the person (Mon compte), else the shared one (Réglages).
  const claudeSource = (userId) =>
    auth.findUser(userId)?.claudeToken ? 'personal' : db.state.secrets?.claudeToken ? 'shared' : null;
  const claudeTokenFor = (userId) => auth.findUser(userId)?.claudeToken || db.state.secrets?.claudeToken || '';
  const github = new GitHub({ apiUrl: config.githubApiUrl, token: githubToken, timeoutMs: config.httpTimeoutMs });
  // Live follow-up: conditional GETs (304 answers are free in the rate limit).
  const devGithub = new GitHub({
    apiUrl: config.githubApiUrl,
    token: githubToken,
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
    if (!githubToken()) return null;
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

  const buildContext = async (integ, addLine) => {
      const state = db.read();
      return {
        integ,
        dryRun: Boolean(integ.simulate),
        gh: new GitHub({
          apiUrl: config.githubApiUrl,
          token: githubToken,
          timeoutMs: config.httpTimeoutMs,
          dryRun: Boolean(integ.simulate),
          onSimulated: ({ method, path }) => addLine(`Simulation : ${method} ${path}`),
        }),
        config,
        settings: { ...state.settings },
        // The Claude token of whoever launched it (older launches: the shared one).
        secrets: { ...state.secrets, claudeToken: claudeTokenFor(integ.launchedBy?.id) },
        repoSettings: loadRepoSettings(),
        deps: checkDeps,
        template: config.template,
        log: addLine,
        db,
      };
  };

  const runner = new Runner({ db, hub, context: buildContext });
  const publisher = new Runner({
    db,
    hub,
    context: buildContext,
    steps: PUBLISH_STEPS,
    field: 'publishSteps',
    label: 'Cette publication',
  });
  // One view and one SSE stream for both: launch + publication.
  runner.decorate = (view, integ) => ({ ...view, publish: publisher.summary(integ) });
  publisher.onChange = (id) => runner.publish(id);

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

  router.get('/api/status', async ({ auth: who }) => {
    const state = db.read();
    return {
      version: APP_VERSION,
      dryRun: config.dryRun,
      realLaunch: REAL_LAUNCH_READY,
      githubTokenSet: Boolean(githubToken()),
      owner: await resolveOwner(),
      claudeTokenSet: Boolean(claudeTokenFor(who.user.id)),
      claudeTokenSource: claudeSource(who.user.id),
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

  router.get('/api/settings', () => publicSettings(db.read(), config));

  // Probes the token rights without changing anything (see github-check.js).
  router.post('/api/github/check', async () => {
    shortCache.clear('github:user');
    return checkToken(github, { owner: db.read().settings.owner || null });
  });
  router.put(
    '/api/settings',
    async ({ body, auth: a, client }) => {
      const result = await saveSettings(db, body ?? {}, config);
      shortCache.clear('github:user');
      devGithub.etags?.clear();
      for (const name of ['githubToken', 'claudeToken']) {
        if (body?.[name] !== undefined) {
          auth.audit(`${name === 'githubToken' ? 'Jeton GitHub' : 'Jeton Claude'} ${body[name] ? 'modifié' : 'effacé'}`, {
            actor: a.user.username,
            ip: client.ip,
          });
        }
      }
      return result;
    },
    { role: 'admin' },
  );

  // --- forum account (Discourse User API Key, copy/paste: no callback URL) ---
  const ADMIN = { role: 'admin' };
  router.post('/api/forum/connect', async () => {
    const { pending, url } = startUserApiKey(config);
    await db.update((s) => {
      s.secrets.forumPending = pending;
    });
    return { url };
  }, ADMIN);

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
    return publicSettings(db.read(), config);
  }, ADMIN);

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
    return publicSettings(db.read(), config);
  }, ADMIN);

  // --- batched announcements in the community topic ---
  // "reserve": "Je prends :" after a launch; "release": "sorties" after a publication.
  const BATCHES = {
    reserve: {
      pending: (state) => state.integrations.filter((i) => !i.simulate && i.forum?.queuedAt && !i.forum?.announced),
      message: reserveBatchMessage,
      mark: (integ, post) => {
        integ.forum = { ...integ.forum, announced: post };
        integ.links = { ...integ.links, forum: post.url };
      },
    },
    release: {
      pending: (state) =>
        state.integrations.filter(
          (i) => !i.simulate && i.release && i.forum?.releaseQueuedAt && i.forum?.released?.version !== i.release.version,
        ),
      message: releaseBatchMessage,
      mark: (integ, post) => {
        integ.forum = { ...integ.forum, released: { ...post, version: integ.release.version } };
      },
    },
  };

  router.get('/api/forum/batch', () => {
    const state = db.read();
    const out = {
      topicUrl: `${config.forumUrl}/t/${forumTopicId()}`,
      connected: Boolean(state.secrets.forumUserApiKey),
      dryRun: config.dryRun,
    };
    for (const [kind, batch] of Object.entries(BATCHES)) {
      const pending = batch.pending(state);
      out[kind] = {
        pending: pending.map((i) => ({ id: i.id, displayName: i.displayName, repo: `${i.owner}/${i.repoName}` })),
        message: pending.length ? batch.message(pending) : '',
      };
    }
    return out;
  });

  router.post('/api/forum/batch', async ({ body }) => {
    const kind = body?.kind ?? 'reserve';
    const batch = BATCHES[kind];
    if (!batch) throw new ApiError(400, 'Type de message inconnu.');
    const state = db.read();
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const chosen = batch.pending(state).filter((i) => ids.includes(i.id));
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
        if (chosen.some((c) => c.id === integ.id)) batch.mark(integ, announced);
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
      .map(({ steps, publishSteps, stepList, ...rest }) => ({ ...rest, publish: { status: rest.publish?.status ?? null } })),
  );

  // One click: everything filled from the tracker idea.
  router.post('/api/launches/quick', async ({ body, auth: who }) => {
    const idea = await findIdea(String(body?.ideaKey ?? ''));
    if (!idea) throw new ApiError(404, 'Idée introuvable dans le tracker.');
    if (idea.bucket !== 'free') throw new ApiError(409, `« ${idea.name} » n’est plus libre (${idea.status}).`);
    return startLaunch(validateLaunch({ ...autofillFromIdea(idea), simulate: body?.simulate === true }), who);
  });

  router.post('/api/launches', ({ body, auth: who }) => startLaunch(validateLaunch(body ?? {}), who));

  async function startLaunch(request, who) {
    const simulate = config.dryRun || request.simulate;
    if (!simulate && !REAL_LAUNCH_READY) {
      throw new ApiError(501, 'Le lancement réel arrive à la phase 3 : cochez « Simulation » pour l’instant.');
    }
    if (!simulate && !githubToken()) throw new ApiError(400, 'Aucun jeton GitHub réglé (page Réglages ou GITHUB_TOKEN).');
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
      claude: request.actions.claude && Boolean(claudeTokenFor(who.user.id)),
      launchedBy: { id: who.user.id, username: who.user.username },
      claudeTokenSource: request.actions.claude ? claudeSource(who.user.id) : null,
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

  // --- publication ("Publier") ---
  router.post('/api/launches/:id/publish', async ({ params }) => {
    const integ = realInteg(params.id, { needIssue: false });
    if (runner.active.has(integ.id)) throw new ApiError(409, 'Le lancement est encore en cours.');
    const launch = runner.summary(integ).status;
    if (!['done', 'warning'].includes(launch)) {
      throw new ApiError(409, 'Le lancement doit être terminé avant de publier (voir les étapes en erreur).');
    }
    if (!githubToken()) throw new ApiError(400, 'Aucun jeton GitHub réglé (page Réglages ou GITHUB_TOKEN).');
    if (config.dryRun) throw new ApiError(409, 'Mode simulation (DRY_RUN) : la publication est désactivée.');
    await publisher.reset(integ.id, { publishAttempt: { startedAt: new Date().toISOString() } });
    publisher.start(integ.id);
    return runner.view(runner.find(integ.id));
  });

  router.post('/api/launches/:id/publish/:step/retry', ({ params }) => {
    publisher.retry(params.id, params.step);
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

  registerAuthRoutes(router, { auth, config, hasSharedClaudeToken: () => Boolean(db.state.secrets?.claudeToken) });

  // --- HTTP -----------------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    let path = url.pathname;
    const client = clientInfo(req, config.trustProxy);

    // Health check: always answered, without auth or base path (Docker).
    if (path === '/healthz') return send(req, res, 200, { ok: true });

    // DNS rebinding guard: a page of another site that resolves to this
    // server must not be able to call the API as same-origin.
    if (!isHostAllowed(req.headers.host, config.allowedHosts)) {
      log.warn('Nom d’hôte refusé', { host: String(req.headers.host ?? '').slice(0, 100), ip: client.ip });
      return send(req, res, 421, {
        error: `Nom d’hôte « ${hostName(req.headers.host)} » non autorisé : ajoutez-le à ALLOWED_HOSTS dans .env.`,
      });
    }

    if (config.basePath) {
      if (path === config.basePath) {
        res.writeHead(301, { location: `${config.basePath}/${url.search}` });
        return res.end();
      }
      if (!path.startsWith(`${config.basePath}/`)) return send(req, res, 404, { error: 'Introuvable' });
      path = path.slice(config.basePath.length);
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

      // Accounts: who is calling, and may they do this?
      const who = auth.authenticate(req);
      if (!found.options.public) {
        if (!who) return send(req, res, 401, { error: 'Connexion requise.', details: { login: true } });
        if (who.access !== 'full' && !found.options.restricted) {
          const why =
            who.access === 'password'
              ? 'Changez d’abord votre mot de passe (page Mon compte).'
              : 'Activez d’abord la double authentification (page Mon compte).';
          return send(req, res, 403, { error: why, details: { access: who.access } });
        }
        const needed = found.options.role ?? (['GET', 'HEAD'].includes(req.method) ? 'viewer' : 'member');
        if (roleRank(who.user.role) < roleRank(needed)) {
          return send(req, res, 403, { error: 'Votre rôle ne permet pas cette action.' });
        }
      }
      try {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : undefined;
        const result = await found.handler({
          req,
          res,
          params: found.params,
          query: url.searchParams,
          body,
          client,
          auth: who,
        });
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

  return { server, router, cache, sources, dashboard, runner, publisher, hub, github, monitor, auth };
}
