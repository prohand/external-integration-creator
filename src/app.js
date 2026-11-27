// -----------------------------------------------------------------------------
// Application: wires the configuration, the storage, the sources and the
// routes into one node:http server.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Cache } from './cache.js';
import { STORE_CATEGORIES } from './categories.js';
import { log } from './log.js';
import { buildBoard, fetchTracker } from './sources/tracker.js';
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
export const APP_VERSION = '0.1.0';

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

export function createApp({ config, db }) {
  const cache = new Cache(config.cacheTtlMs);
  const checkAuth = createBasicAuth({ user: config.appUser, password: config.appPassword });
  const router = new Router();

  const sources = {
    tracker: (opts) => cache.get('tracker', () => fetchTracker(config), opts),
  };

  async function dashboard({ force = false } = {}) {
    const result = await sources.tracker({ force });
    const board = buildBoard(result.value, db.read().reservations);
    const columns = {};
    for (const [name, items] of Object.entries(board.columns)) columns[name] = items.map(card);
    return {
      fetchedAt: new Date(result.fetchedAt).toISOString(),
      stale: result.stale,
      warning: result.error ? `Données en cache : ${result.error.message}` : null,
      counts: board.counts,
      columns,
    };
  }

  router.get('/api/status', () => ({
    version: APP_VERSION,
    dryRun: config.dryRun,
    githubTokenSet: Boolean(config.githubToken),
    cacheMinutes: config.cacheTtlMs / 60_000,
    categories: STORE_CATEGORIES,
  }));

  router.get('/api/dashboard', () => dashboard());
  // Forces a new download; the previous data stays available if it fails.
  router.post('/api/refresh', () => dashboard({ force: true }));

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
      if (auth.status === 401) log.warn('Authentification refusée', { ip: client.ip });
      return send(
        req,
        res,
        auth.status,
        { error: auth.status === 429 ? 'Trop de tentatives, réessayez plus tard.' : 'Authentification requise.' },
        auth.status === 401 ? { 'www-authenticate': 'Basic realm="Integration Creator", charset="UTF-8"' } : {},
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

  return { server, router, cache, sources, dashboard };
}
