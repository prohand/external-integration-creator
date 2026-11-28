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

/**
 * Client info. Behind a trusted reverse proxy (TRUST_PROXY=true), the client
 * address is the LAST X-Forwarded-For entry: the one the proxy appended. The
 * entries before it come from the client and can be anything.
 */
export function clientInfo(req, trustProxy) {
  const last = (h) => String(req.headers[h] ?? '').split(',').map((v) => v.trim()).filter(Boolean).at(-1) ?? '';
  const fromProxy = (h) => (trustProxy ? last(h) : '');
  return {
    ip: fromProxy('x-forwarded-for') || req.socket.remoteAddress || '',
    proto: fromProxy('x-forwarded-proto') || (req.socket.encrypted ? 'https' : 'http'),
    host: fromProxy('x-forwarded-host') || req.headers.host || '',
  };
}

/** Host name of a Host header ("[::1]:3000" -> "::1", "a.b:80" -> "a.b"). */
export function hostName(header) {
  const value = String(header ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.replace(/:\d+$/, '');
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

/**
 * DNS rebinding guard: IP addresses and localhost are accepted, a domain name
 * only when listed in ALLOWED_HOSTS ("*.example.org" allows subdomains).
 */
export function isHostAllowed(header, allowedHosts = []) {
  const host = hostName(header);
  if (!host) return false;
  if (host === 'localhost' || IPV4.test(host) || host.includes(':')) return true;
  return allowedHosts.some((rule) =>
    rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule,
  );
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

export const AUTH_LIMITS = {
  window: 15 * 60_000, // failures are counted over 15 minutes
  perAddress: 10, // then that address is blocked until the window ends
  global: 100, // and every address is slowed down past this many failures
  maxTracked: 10_000, // addresses remembered at most (oldest dropped first)
};

/**
 * Basic Auth check. Returns { ok: true } when no password is configured.
 * Failures are limited per address and globally (429), so that changing
 * addresses does not allow unlimited guessing.
 */
export function createBasicAuth({ user, password, limits = AUTH_LIMITS, now = () => Date.now() }) {
  const failures = new Map(); // ip -> { count, since }
  let global = { count: 0, since: now() };

  const forget = (t) => {
    for (const [ip, entry] of failures) {
      if (t - entry.since > limits.window) failures.delete(ip);
    }
  };

  const check = function check(req, ip) {
    if (!password) return { ok: true };
    const t = now();
    if (t - global.since > limits.window) global = { count: 0, since: t };
    const entry = failures.get(ip);
    if (entry && t - entry.since > limits.window) failures.delete(ip);
    if ((failures.get(ip)?.count ?? 0) >= limits.perAddress) return { ok: false, status: 429 };
    if (global.count >= limits.global) return { ok: false, status: 429 };

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
      global.count += 1;
      const current = failures.get(ip) ?? { count: 0, since: t };
      current.count += 1;
      failures.delete(ip);
      failures.set(ip, current);
      if (failures.size > limits.maxTracked) {
        forget(t);
        while (failures.size > limits.maxTracked) failures.delete(failures.keys().next().value);
      }
    }
    return { ok: false, status: 401 };
  };
  check.tracked = () => failures.size;
  return check;
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
