// -----------------------------------------------------------------------------
// External Integration Creator — browser side. Plain JavaScript, no build step.
// Every text coming from the tracker, the forum or GitHub is inserted with
// textContent (see `h()`), never with innerHTML.
// -----------------------------------------------------------------------------

const state = {
  status: null,
  dashboard: null,
  search: '',
  category: '',
  limits: { free: 60, progress: 60, exists: 60 },
};

// --- helpers -----------------------------------------------------------------

/** Builds an element. Strings and numbers become text nodes. */
function h(tag, props = {}, ...children) {
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
function safeHref(value) {
  const s = String(value);
  if (s.startsWith('#')) return s;
  try {
    const url = new URL(s, document.baseURI);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}

function extLink(href, label) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
}

async function api(path, { method = 'GET', body } = {}) {
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
  if (!response.ok) {
    const error = new Error(data.error || `Erreur ${response.status}`);
    error.details = data.details;
    throw error;
  }
  return data;
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function categoryLabel(key) {
  return state.status?.categories.find((c) => c.key === key)?.label ?? key;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function setView(...children) {
  const view = document.getElementById('view');
  view.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function errorBox(message) {
  return h('div', { class: 'alert alert-error', role: 'alert' }, message);
}

// --- dashboard -----------------------------------------------------------------

const COLUMNS = [
  { key: 'exists', title: 'Existe', hint: 'Publiée, native ou déjà dans le store' },
  { key: 'progress', title: 'En cours', hint: 'Quelqu’un travaille dessus' },
  { key: 'free', title: 'Libre', hint: 'Personne ne travaille dessus' },
];

const PRIO_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

function matches(item) {
  if (state.category && !item.categories?.includes(state.category)) return false;
  if (!state.search) return true;
  const haystack = normalize(
    [item.name, item.gladysName, item.description, item.repo, item.author, item.rawCategory].join(' '),
  );
  return normalize(state.search)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

function sortItems(key, items) {
  if (key !== 'free') return items;
  return [...items].sort(
    (a, b) =>
      (PRIO_RANK[a.prio] ?? 9) - (PRIO_RANK[b.prio] ?? 9) ||
      (b.installs ?? 0) - (a.installs ?? 0) ||
      a.name.localeCompare(b.name, 'fr'),
  );
}

function renderCard(item, column) {
  const links = [];
  if (item.docUrl) links.push(extLink(item.docUrl, 'Doc HA'));
  if (item.repo) links.push(extLink(`https://github.com/${item.repo}`, item.repo));

  return h(
    'article',
    { class: `card card-${column}` },
    h(
      'div',
      { class: 'card-head' },
      h('h3', {}, item.name),
      item.prio ? h('span', { class: 'badge', title: 'Priorité dans le tracker' }, item.prio) : null,
    ),
    h(
      'div',
      { class: 'card-tags' },
      h(
        'span',
        { class: `badge status${item.unknownStatus ? ' badge-warn' : ''}`, title: item.unknownStatus ? 'Statut inconnu de l’appli' : null },
        item.status,
      ),
      item.reservedLocally ? h('span', { class: 'badge badge-info' }, 'Réservée ici') : null,
      (item.categories ?? []).map((c) => h('span', { class: 'badge badge-cat' }, categoryLabel(c))),
      item.noHardware ? h('span', { class: 'badge' }, 'Sans matériel') : null,
      item.access ? h('span', { class: 'badge' }, item.access) : null,
    ),
    item.description ? h('p', { class: 'card-desc' }, item.description) : null,
    item.gladysName && item.gladysName !== item.name
      ? h('p', { class: 'muted small' }, `Côté Gladys : ${item.gladysName}${item.author ? ` (par ${item.author})` : ''}`)
      : item.author
        ? h('p', { class: 'muted small' }, `Par ${item.author}`)
        : null,
    (item.notes ?? []).map((note) => h('p', { class: 'note small' }, note)),
    h(
      'div',
      { class: 'card-foot' },
      h('span', { class: 'card-links' }, links),
      column === 'free'
        ? h('a', { class: 'button button-primary', href: `#/lancer/${encodeURIComponent(item.key)}` }, 'Lancer')
        : null,
    ),
  );
}

function renderColumns() {
  const data = state.dashboard;
  const host = document.getElementById('columns');
  if (!host || !data) return;
  host.replaceChildren(
    ...COLUMNS.map(({ key, title, hint }) => {
      const all = data.columns[key];
      const filtered = sortItems(key, all.filter(matches));
      const shown = filtered.slice(0, state.limits[key]);
      const count = filtered.length === all.length ? `${all.length}` : `${filtered.length} / ${all.length}`;
      return h(
        'section',
        { class: `column column-${key}`, 'aria-label': title },
        h('header', { class: 'column-head' }, h('h2', {}, title), h('span', { class: 'counter' }, count)),
        h('p', { class: 'muted small' }, hint),
        shown.length ? shown.map((item) => renderCard(item, key)) : h('p', { class: 'muted' }, 'Aucun résultat.'),
        filtered.length > shown.length
          ? h(
              'button',
              {
                class: 'button',
                type: 'button',
                onclick: () => {
                  state.limits[key] += 60;
                  renderColumns();
                },
              },
              `Afficher plus (${filtered.length - shown.length} restantes)`,
            )
          : null,
      );
    }),
  );
}

function renderDashboard() {
  const data = state.dashboard;
  const categories = state.status?.categories ?? [];

  const search = h('input', {
    type: 'search',
    placeholder: 'Rechercher (nom, description, dépôt…)',
    value: state.search,
    'aria-label': 'Rechercher',
    oninput: (e) => {
      state.search = e.target.value;
      resetLimits();
      renderColumns();
    },
  });

  const select = h(
    'select',
    {
      'aria-label': 'Catégorie',
      onchange: (e) => {
        state.category = e.target.value;
        resetLimits();
        renderColumns();
      },
    },
    h('option', { value: '' }, 'Toutes les catégories'),
    categories.map((c) => h('option', { value: c.key, selected: state.category === c.key }, c.label)),
  );

  const refresh = h(
    'button',
    {
      class: 'button',
      type: 'button',
      onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Actualisation…';
        try {
          state.dashboard = await api('refresh', { method: 'POST' });
          renderDashboard();
        } catch (err) {
          setView(errorBox(err.message));
        }
      },
    },
    'Actualiser',
  );

  const totals = h(
    'p',
    { class: 'totals' },
    COLUMNS.map(({ key, title }) => h('span', { class: `total total-${key}` }, h('strong', {}, data.counts[key]), ` ${title.toLowerCase()}`)),
  );

  setView(
    h(
      'div',
      { class: 'toolbar' },
      search,
      select,
      refresh,
      h('span', { class: 'muted small' }, `Tracker lu le ${formatDate(data.fetchedAt)}`),
    ),
    data.warning ? h('div', { class: 'alert alert-warn' }, data.warning) : null,
    totals,
    h('div', { id: 'columns', class: 'columns' }),
  );
  renderColumns();
}

function resetLimits() {
  state.limits = { free: 60, progress: 60, exists: 60 };
}

async function showDashboard() {
  if (!state.dashboard) {
    setView(h('p', { class: 'muted' }, 'Lecture du tracker…'));
    try {
      state.dashboard = await api('dashboard');
    } catch (err) {
      setView(
        errorBox(err.message),
        h('button', { class: 'button', type: 'button', onclick: showDashboard }, 'Réessayer'),
      );
      return;
    }
  }
  renderDashboard();
}

// --- other screens (filled in the next phases) ---------------------------------

function showLaunch(key) {
  const all = state.dashboard ? Object.values(state.dashboard.columns).flat() : [];
  const item = all.find((i) => i.key === key);
  setView(
    h('h1', {}, `Lancer ${item ? item.name : ''}`),
    h('p', { class: 'muted' }, 'Le formulaire de lancement arrive à l’étape suivante.'),
    h('a', { class: 'button', href: '#/' }, 'Retour au tableau de bord'),
  );
}

function showMine() {
  setView(h('h1', {}, 'Mes intégrations'), h('p', { class: 'muted' }, 'Aucune intégration lancée pour l’instant.'));
}

function showSettings() {
  const s = state.status;
  setView(
    h('h1', {}, 'Réglages'),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Version'),
      h('dd', {}, s?.version ?? '?'),
      h('dt', {}, 'Jeton GitHub'),
      h('dd', {}, s?.githubTokenSet ? 'Réglé' : 'Non réglé'),
      h('dt', {}, 'Mode simulation'),
      h('dd', {}, s?.dryRun ? 'Oui' : 'Non'),
      h('dt', {}, 'Cache des sources'),
      h('dd', {}, `${s?.cacheMinutes ?? '?'} min`),
    ),
  );
}

// --- router --------------------------------------------------------------------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  const nav = { '': 'dashboard', 'mes-integrations': 'mine', reglages: 'settings', lancer: 'dashboard' }[page];
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.toggleAttribute('aria-current', a.dataset.nav === nav);
  });
  if (page === 'lancer') return showLaunch(decodeURIComponent(rest.join('/')));
  if (page === 'mes-integrations') return showMine();
  if (page === 'reglages') return showSettings();
  return showDashboard();
}

async function start() {
  try {
    state.status = await api('status');
    document.getElementById('mode').hidden = !state.status.dryRun;
  } catch (err) {
    setView(errorBox(err.message));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

start();
