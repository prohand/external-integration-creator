// -----------------------------------------------------------------------------
// Outbound HTTP helpers around the native fetch: timeout, generic User-Agent,
// readable errors. No personal data is ever sent in headers.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-integration-creator';

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export async function httpRequest(url, { timeoutMs = 20_000, headers = {}, ...options } = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { 'user-agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'délai dépassé' : err.cause?.code || err.message;
    throw new HttpError(`Impossible de joindre ${new URL(url).host} (${reason})`, { url });
  }
  return response;
}

export async function fetchText(url, options) {
  const response = await httpRequest(url, options);
  const body = await response.text();
  if (!response.ok) {
    throw new HttpError(`${new URL(url).host} a répondu ${response.status}`, {
      status: response.status,
      url,
      body: body.slice(0, 500),
    });
  }
  return body;
}

export async function fetchJson(url, options) {
  const text = await fetchText(url, { ...options, headers: { accept: 'application/json', ...options?.headers } });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`Réponse JSON invalide de ${new URL(url).host}`, { url });
  }
}
