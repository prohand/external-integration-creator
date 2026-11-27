// -----------------------------------------------------------------------------
// HTTP plumbing on node:http: tiny router, JSON bodies and responses (gzip),
// reverse-proxy aware client info, optional Basic Auth, static files.
// -----------------------------------------------------------------------------

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }

  /** `path` may contain ":param" segments, e.g. "/api/launches/:id". */
  add(method, path, handler) {
    const names = [];
    const pattern = path.replace(/:([a-zA-Z]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${pattern}$`), names, handler });
    return this;
  }

  get(path, handler) {
    return this.add('GET', path, handler);
  }

  post(path, handler) {
    return this.add('POST', path, handler);
  }

  put(path, handler) {
    return this.add('PUT', path, handler);
  }

  delete(path, handler) {
    return this.add('DELETE', path, handler);
  }

  match(method, path) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/** Client info, reading the X-Forwarded-* headers when behind a trusted proxy. */
export function clientInfo(req, trustProxy) {
  const first = (h) => String(req.headers[h] ?? '').split(',')[0].trim();
  const fromProxy = (h) => (trustProxy ? first(h) : '');
  return {
    ip: fromProxy('x-forwarded-for') || req.socket.remoteAddress || '',
    proto: fromProxy('x-forwarded-proto') || (req.socket.encrypted ? 'https' : 'http'),
    host: fromProxy('x-forwarded-host') || req.headers.host || '',
  };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function send(req, res, status, body, headers = {}) {
  let payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const out = { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...headers };
  if (!out['content-type']) out['content-type'] = 'application/json; charset=utf-8';
  if (
    payload.length > 2048 &&
    /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) &&
    /json|text|javascript|css|html/.test(out['content-type'])
  ) {
    payload = gzipSync(payload);
    out['content-encoding'] = 'gzip';
    out.vary = 'Accept-Encoding';
  }
  out['content-length'] = Buffer.byteLength(payload);
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

export async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!/application\/json/.test(String(req.headers['content-type'] ?? ''))) {
    throw new ApiError(415, 'Le corps de la requête doit être du JSON.');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'JSON invalide.');
  }
}

const digest = (value) => createHash('sha256').update(String(value)).digest();

/**
 * Basic Auth check. Returns true when no password is configured.
 * Repeated failures from one address are slowed down (429).
 */
export function createBasicAuth({ user, password }) {
  const failures = new Map(); // ip -> { count, since }
  const WINDOW = 15 * 60_000;
  const MAX = 10;
  return function check(req, ip) {
    if (!password) return { ok: true };
    const now = Date.now();
    const entry = failures.get(ip);
    if (entry && now - entry.since > WINDOW) failures.delete(ip);
    if ((failures.get(ip)?.count ?? 0) >= MAX) return { ok: false, status: 429 };

    const match = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const u = decoded.slice(0, colon);
      const p = decoded.slice(colon + 1);
      const okUser = timingSafeEqual(digest(u), digest(user));
      const okPass = timingSafeEqual(digest(p), digest(password));
      if (colon >= 0 && okUser && okPass) {
        failures.delete(ip);
        return { ok: true };
      }
      const current = failures.get(ip) ?? { count: 0, since: now };
      current.count += 1;
      failures.set(ip, current);
    }
    return { ok: false, status: 401 };
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** Serves a file of `root`; `index.html` gets a <base href> matching BASE_PATH. */
export async function serveStatic(req, res, root, path, basePath) {
  const rel = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/, '');
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep) || !MIME[extname(file)]) return false;
  let content;
  try {
    content = await readFile(file);
  } catch {
    return false;
  }
  if (rel === 'index.html') {
    content = content
      .toString('utf8')
      .replace(/<base href="[^"]*"\s*\/?>/, `<base href="${basePath}/" />`);
  }
  send(req, res, 200, content, {
    'content-type': MIME[extname(file)],
    'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
  });
  return true;
}
