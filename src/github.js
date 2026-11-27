// -----------------------------------------------------------------------------
// GitHub REST client on the native fetch.
// - DRY_RUN: write calls (POST/PUT/PATCH/DELETE) are never sent, they are
//   reported through `onSimulated` and return a simulated response.
// - Errors name the missing token permission when GitHub tells which one
//   (header `x-accepted-github-permissions`), in plain French.
// -----------------------------------------------------------------------------

import { USER_AGENT } from './http.js';

// What each fine-grained permission is used for (shown to the user).
export const PERMISSIONS = {
  administration: {
    label: 'Administration',
    use: 'créer le dépôt, appliquer ses réglages, ses topics et ses alertes de sécurité',
  },
  contents: { label: 'Contents', use: 'personnaliser les fichiers du dépôt et lire le code' },
  workflows: { label: 'Workflows', use: 'ajouter les workflows dans .github/workflows' },
  secrets: { label: 'Secrets', use: 'enregistrer le secret CLAUDE_CODE_OAUTH_TOKEN' },
  issues: { label: 'Issues', use: 'créer l’issue de suivi, les étiquettes et écrire à Claude' },
  actions: { label: 'Actions', use: 'lancer la release et la CI, suivre les exécutions' },
  metadata: { label: 'Metadata', use: 'lire les informations de base des dépôts' },
  watching: { label: 'Watching (droit du compte)', use: 'suivre (« Watch ») le nouveau dépôt' },
  pull_requests: { label: 'Pull requests', use: 'lire les pull requests' },
};

const LEVEL = { read: 'lecture', write: 'écriture', admin: 'administration' };

/** "administration=write; contents=read" -> readable French sentence. */
export function describePermissions(header) {
  if (!header) return null;
  const parts = String(header)
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [name, level] = p.split('=').map((s) => s.trim());
      const info = PERMISSIONS[name];
      const label = info?.label ?? name;
      return `${label} (${LEVEL[level] ?? level})${info ? ` : sert à ${info.use}` : ''}`;
    });
  return parts.length ? `Droit manquant sur le jeton GitHub : ${parts.join(' ; ')}.` : null;
}

export class GitHubError extends Error {
  constructor(message, { status, method, path, permission, data } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.permission = permission;
    this.data = data;
  }
}

export class GitHub {
  constructor({ apiUrl, token, dryRun = false, timeoutMs = 20_000, onSimulated } = {}) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.dryRun = dryRun;
    this.timeoutMs = timeoutMs;
    this.onSimulated = onSimulated;
  }

  /**
   * Sends a request. Returns { status, data, headers, simulated }.
   * `allow`: extra statuses accepted without throwing (e.g. [404]).
   * `simulate`: value (or function) returned instead of a write in DRY_RUN.
   */
  async request(method, path, { body, allow = [], simulate, accept, raw = false } = {}) {
    const write = !['GET', 'HEAD'].includes(method);
    if (write && this.dryRun) {
      this.onSimulated?.({ method, path, body });
      const data = typeof simulate === 'function' ? simulate() : (simulate ?? {});
      return { status: 0, data, headers: new Headers(), simulated: true };
    }

    const url = /^https?:\/\//.test(path) ? path : `${this.apiUrl}${path}`;
    const headers = {
      accept: accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'délai dépassé' : err.cause?.code || err.message;
      throw new GitHubError(`GitHub injoignable (${reason})`, { method, path });
    }

    const text = await response.text();
    let data = text;
    if (!raw && text) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep the text (logs, raw files)
      }
    }
    if (response.ok || allow.includes(response.status)) {
      return { status: response.status, data, headers: response.headers, simulated: false };
    }
    throw this.error(method, path, response, data);
  }

  error(method, path, response, data) {
    const status = response.status;
    const apiMessage = typeof data === 'object' && data?.message ? data.message : '';
    const permission = describePermissions(response.headers.get('x-accepted-github-permissions'));
    let message;
    if (status === 401) {
      message = 'Jeton GitHub refusé (absent, expiré ou révoqué).';
    } else if (
      (status === 403 || status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      message = `Limite d'appels GitHub atteinte${reset ? `, réessayez après ${new Date(reset).toLocaleTimeString('fr-FR')}` : ''}.`;
    } else if ((status === 403 || status === 404) && permission) {
      message = permission;
    } else {
      const details =
        typeof data === 'object' && Array.isArray(data?.errors)
          ? data.errors.map((e) => e.message || e.code).filter(Boolean).join(', ')
          : '';
      message = `GitHub a répondu ${status} à ${method} ${path}${apiMessage ? ` : ${apiMessage}` : ''}${details ? ` (${details})` : ''}`;
    }
    return new GitHubError(message, { status, method, path, permission, data });
  }

  async get(path, opts) {
    return (await this.request('GET', path, opts)).data;
  }

  /** True when the resource exists (200), false on 404. */
  async exists(path) {
    const { status } = await this.request('GET', path, { allow: [404] });
    return status !== 404;
  }

  post(path, body, opts) {
    return this.request('POST', path, { ...opts, body });
  }

  put(path, body, opts) {
    return this.request('PUT', path, { ...opts, body });
  }

  patch(path, body, opts) {
    return this.request('PATCH', path, { ...opts, body });
  }

  delete(path, opts) {
    return this.request('DELETE', path, opts);
  }

  /** Text content of a file, or null when it does not exist. */
  async readFile(owner, repo, path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const { status, data } = await this.request(
      'GET',
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`,
      { allow: [404] },
    );
    if (status === 404) return null;
    if (data?.encoding === 'base64') return Buffer.from(data.content, 'base64').toString('utf8');
    if (typeof data?.content === 'string') return data.content;
    // Files over 1 MB: download_url.
    if (data?.download_url) {
      return (await this.request('GET', data.download_url, { raw: true, accept: '*/*' })).data;
    }
    return null;
  }
}
