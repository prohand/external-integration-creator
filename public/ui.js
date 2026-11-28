// -----------------------------------------------------------------------------
// Shared browser helpers: DOM builder, API calls, small view helpers.
// Every text coming from outside is inserted with textContent (see `h()`),
// never with innerHTML.
// -----------------------------------------------------------------------------

/** Called when the API answers 401 (session expired): shows the login page. */
let onLoggedOut = () => {};
export function setLoggedOutHandler(fn) {
  onLoggedOut = fn;
}

/** Builds an element. Strings and numbers become text nodes. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'href') el.setAttribute('href', safeHref(value));
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Only http(s) links and in-app hashes are allowed. */
export function safeHref(value) {
  const s = String(value);
  if (s.startsWith('#')) return s;
  try {
    const url = new URL(s, document.baseURI);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}

export function extLink(href, label) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`api/${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(method !== 'GET' ? { 'x-requested-with': 'integration-creator' } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && data.details?.login) onLoggedOut();
  if (!response.ok) {
    const error = new Error(data.error || `Erreur ${response.status}`);
    error.details = data.details;
    throw error;
  }
  return data;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function setView(...children) {
  const view = document.getElementById('view');
  view.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

export function errorBox(message) {
  return h('div', { class: 'alert alert-error', role: 'alert' }, message);
}

export function loading(text = 'Chargement…') {
  return h('p', { class: 'muted' }, text);
}

export function field(label, control, { hint, error } = {}) {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'muted small' }, hint) : null,
    error,
  );
}

