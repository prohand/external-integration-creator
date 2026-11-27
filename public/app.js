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
        ? h(
            'span',
            { class: 'card-actions' },
            h('a', { class: 'small', href: `#/lancer/${encodeURIComponent(item.key)}` }, 'Personnaliser…'),
            h('button', { class: 'button button-primary', type: 'button', onclick: (e) => quickLaunch(item, e.currentTarget) }, 'Lancer'),
          )
        : null,
    ),
  );
}

/** One click: everything is filled from the tracker, one confirmation. */
async function quickLaunch(item, button) {
  const s = state.status;
  const simulated = s.dryRun || !s.realLaunch;
  if (!simulated && !s.owner) {
    alert('Réglez d’abord le jeton GitHub (.env) ou le compte cible (Réglages).');
    return;
  }
  const repo = `${s.owner ?? 'votre-compte'}/${defaultRepoName(item.name)}`;
  const message = simulated
    ? `Simuler le lancement de « ${item.name} » ? Rien ne sera créé.`
    : `Lancer « ${item.name} » ?\n\nLe dépôt public ${repo} va être créé sur GitHub, avec son issue de suivi` +
      `${s.claudeTokenSet ? ', et Claude se met au travail' : ''}.\n\nTout est rempli depuis le tracker ; Claude rédige ensuite les descriptions.`;
  if (!confirm(message)) return;
  button.disabled = true;
  try {
    const launch = await api('launches/quick', { method: 'POST', body: { ideaKey: item.key } });
    state.dashboard = null;
    location.hash = `#/suivi/${launch.id}`;
  } catch (err) {
    alert(err.message);
    button.disabled = false;
  }
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

// --- shared bits for the next screens ---------------------------------------------

let stream = null; // EventSource of the follow screen
let devStream = null; // EventSource of the "Développement" tab

function closeDevStream() {
  if (devStream) {
    devStream.close();
    devStream = null;
  }
}

function closeStream() {
  if (stream) {
    stream.close();
    stream = null;
  }
  closeDevStream();
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function defaultRepoName(name) {
  const slug = slugify(name).replace(/^gladys-/, '');
  return slug ? `gladys-${slug}` : '';
}

const STEP_LABELS = {
  todo: 'À faire',
  running: 'En cours',
  done: 'Fait',
  warning: 'Attention',
  error: 'Erreur',
  skipped: 'Sautée',
};

const OVERALL_LABELS = {
  running: 'En cours',
  done: 'Terminé',
  warning: 'Terminé avec avertissements',
  error: 'Erreur',
  todo: 'Incomplet',
};

function statusBadge(status, labels = STEP_LABELS) {
  return h('span', { class: `badge st st-${status}` }, labels[status] ?? status);
}

function loading(text = 'Chargement…') {
  return h('p', { class: 'muted' }, text);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const CHECK_ICONS = { true: '✓', false: '✗', null: '?' };

function renderChecks(checks) {
  return h(
    'ul',
    { class: 'checks' },
    checks.map((c) =>
      h(
        'li',
        { class: `check check-${c.ok === true ? 'ok' : c.ok === false ? 'ko' : 'unknown'}` },
        h('span', { class: 'check-icon', 'aria-hidden': 'true' }, CHECK_ICONS[String(c.ok)]),
        h('strong', {}, c.label),
        ' ',
        h('span', {}, c.message),
        c.link ? [' ', extLink(c.link, 'voir')] : null,
        c.notes?.length
          ? h(
              'ul',
              { class: 'check-notes' },
              c.notes.map((n) => h('li', { class: 'small' }, n.text, ' ', n.link ? extLink(n.link, 'lire') : null)),
            )
          : null,
      ),
    ),
  );
}

// --- launch form ---------------------------------------------------------------------

const LANGS = [
  { key: 'fr', label: 'Français' },
  { key: 'en', label: 'Anglais' },
  { key: 'de', label: 'Allemand' },
  { key: 'es', label: 'Espagnol' },
];

function field(label, control, { hint, error } = {}) {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'muted small' }, hint) : null,
    error,
  );
}

async function showLaunch(key) {
  closeStream();
  setView(loading('Préparation du formulaire…'));
  let prefill;
  try {
    prefill = await api(`prefill?idea=${encodeURIComponent(key)}`);
  } catch (err) {
    setView(errorBox(err.message));
    return;
  }
  const s = state.status;
  const form = {
    displayName: prefill.displayName,
    repoName: prefill.repoName,
    repoEdited: false,
    description: { ...prefill.description },
    categories: new Set(prefill.categories),
    keywords: prefill.keywords.join(', '),
    spec: prefill.spec ?? '',
    actions: Object.fromEntries(s.options.map((o) => [o.key, true])),
    simulate: s.dryRun || !s.realLaunch,
  };
  if (!s.claudeTokenSet) form.actions.claude = false;

  const errors = {};
  const errorEl = (name) => {
    errors[name] = h('span', { class: 'field-error', role: 'alert' });
    return errors[name];
  };
  const showErrors = (details = {}) => {
    for (const [name, el] of Object.entries(errors)) el.textContent = details[name] ?? '';
    // An error in a folded field: unfold the "Avancé" block.
    if (Object.keys(details).some((k) => k !== 'displayName' && k !== 'repoName')) advanced.open = true;
  };

  // Name + repository + live check.
  const owner = prefill.owner;
  const preview = h('div', { class: 'preview' });
  const checkBox = h('div', { class: 'check-box' }, loading('Vérification du nom…'));
  const renderPreview = () => {
    const repo = form.repoName || '…';
    preview.replaceChildren(
      owner
        ? h(
            'dl',
            { class: 'facts' },
            h('dt', {}, 'Dépôt'),
            h('dd', {}, h('code', {}, `https://github.com/${owner}/${repo}`)),
            h('dt', {}, 'Image'),
            h('dd', {}, h('code', {}, `ghcr.io/${owner}/${repo}:1.0.0`.toLowerCase())),
          )
        : h(
            'p',
            { class: 'alert alert-warn' },
            'Compte GitHub cible inconnu : réglez-le dans ',
            h('a', { href: '#/reglages' }, 'Réglages'),
            '.',
          ),
    );
  };
  let checkSeq = 0;
  const runCheck = debounce(async () => {
    const seq = ++checkSeq;
    if (!form.displayName.trim() || !form.repoName.trim()) {
      checkBox.replaceChildren(h('p', { class: 'muted' }, 'Saisissez un nom.'));
      return;
    }
    checkBox.replaceChildren(loading('Vérification du nom…'));
    try {
      const params = new URLSearchParams({ displayName: form.displayName, repoName: form.repoName, ideaKey: key });
      const report = await api(`check-name?${params}`);
      if (seq !== checkSeq) return;
      checkBox.replaceChildren(
        h(
          'p',
          {
            class: report.conflicts
              ? 'alert alert-error'
              : report.unknown || report.mentions
                ? 'alert alert-warn'
                : 'alert alert-ok',
          },
          report.conflicts
            ? 'Ce nom est déjà pris.'
            : report.unknown
              ? 'Nom libre, mais une source n’a pas pu être vérifiée.'
              : report.mentions
                ? 'Nom libre, mais cité sur le forum : lisez ces messages avant de lancer (quelqu’un l’a peut-être pris).'
                : 'Nom libre partout.',
        ),
        renderChecks(report.checks),
      );
    } catch (err) {
      if (seq === checkSeq) checkBox.replaceChildren(errorBox(err.message));
    }
  }, 600);

  const repoInput = h('input', {
    type: 'text',
    value: form.repoName,
    required: true,
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: (e) => {
      form.repoName = e.target.value.trim();
      form.repoEdited = true;
      renderPreview();
      runCheck();
    },
  });
  const nameInput = h('input', {
    type: 'text',
    value: form.displayName,
    required: true,
    maxlength: 60,
    oninput: (e) => {
      form.displayName = e.target.value;
      if (!form.repoEdited) {
        form.repoName = defaultRepoName(form.displayName);
        repoInput.value = form.repoName;
      }
      renderPreview();
      runCheck();
    },
  });

  // Descriptions with counters.
  const descInputs = {};
  const counter = (lang) => {
    const el = h('span', { class: 'counter small' });
    const update = () => {
      const n = (form.description[lang] ?? '').trim().length;
      el.textContent = `${n} / 100`;
      el.classList.toggle('counter-bad', n < 10 || n > 100);
    };
    update();
    return { el, update };
  };
  const descFields = LANGS.map(({ key: lang, label }) => {
    const c = counter(lang);
    descInputs[lang] = h('input', {
      type: 'text',
      value: form.description[lang] ?? '',
      maxlength: 120,
      oninput: (e) => {
        form.description[lang] = e.target.value;
        c.update();
      },
    });
    descInputs[lang].counter = c;
    return field(h('span', {}, `Description (${label}) `, c.el), descInputs[lang], { error: errorEl(`description.${lang}`) });
  });
  const copyEnglish = h(
    'button',
    {
      class: 'button small',
      type: 'button',
      onclick: () => {
        for (const { key: lang } of LANGS) {
          if (!form.description[lang]?.trim()) {
            form.description[lang] = form.description.en ?? '';
            descInputs[lang].value = form.description[lang];
            descInputs[lang].counter.update();
          }
        }
      },
    },
    'Copier l’anglais dans les champs vides',
  );

  // Categories (1 to 3).
  const catBoxes = [];
  const catCount = h('span', { class: 'counter small' });
  const syncCats = () => {
    catCount.textContent = `${form.categories.size} / 3`;
    for (const box of catBoxes) box.disabled = !box.checked && form.categories.size >= 3;
  };
  const categories = h(
    'div',
    { class: 'grid-checks' },
    s.categories.map((c) => {
      const box = h('input', {
        type: 'checkbox',
        value: c.key,
        checked: form.categories.has(c.key),
        onchange: (e) => {
          if (e.target.checked) form.categories.add(c.key);
          else form.categories.delete(c.key);
          syncCats();
        },
      });
      catBoxes.push(box);
      return h('label', { class: 'check-line' }, box, ` ${c.label}`);
    }),
  );
  syncCats();

  // Automatic actions.
  const options = h(
    'div',
    { class: 'options' },
    s.options.map((o) => {
      const disabledReason =
        o.key === 'claude' && !s.claudeTokenSet ? 'aucun jeton Claude (Réglages)' : null;
      return h(
        'label',
        { class: 'check-line' },
        h('input', {
          type: 'checkbox',
          checked: form.actions[o.key],
          disabled: Boolean(disabledReason),
          onchange: (e) => {
            form.actions[o.key] = e.target.checked;
          },
        }),
        ` ${o.label}`,
        disabledReason ? h('span', { class: 'muted small' }, ` — ${disabledReason}`) : null,
      );
    }),
  );

  const simulateLocked = s.dryRun || !s.realLaunch;
  const simulate = h(
    'label',
    { class: 'check-line' },
    h('input', {
      type: 'checkbox',
      checked: form.simulate,
      disabled: simulateLocked,
      onchange: (e) => {
        form.simulate = e.target.checked;
      },
    }),
    ' Simulation : dérouler toutes les étapes sans rien créer',
    simulateLocked
      ? h(
          'span',
          { class: 'muted small' },
          s.dryRun ? ' — imposée (DRY_RUN=true)' : ' — imposée : lancement réel désactivé',
        )
      : null,
  );

  const formError = h('div');
  const submit = h('button', { class: 'button button-primary', type: 'submit' }, 'Lancer');

  const onSubmit = async (e) => {
    e.preventDefault();
    if (
      !form.simulate &&
      !confirm(
        `Lancer pour de vrai ?\n\nLe dépôt public ${owner ?? '?'}/${form.repoName} va être créé sur GitHub, avec ses réglages, son issue de suivi` +
          `${form.actions.claude ? ' et Claude' : ''}.`,
      )
    ) {
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Lancement…';
    formError.replaceChildren();
    showErrors();
    try {
      const launch = await api('launches', {
        method: 'POST',
        body: {
          ideaKey: key || null,
          displayName: form.displayName,
          repoName: form.repoName,
          description: form.description,
          categories: [...form.categories],
          keywords: form.keywords,
          spec: form.spec,
          actions: form.actions,
          simulate: form.simulate,
          // Generic descriptions kept: Claude is asked to write real ones.
          autoFilled: ['fr', 'de', 'es'].some((l) => form.description[l] === prefill.description[l]),
        },
      });
      state.dashboard = null; // reservations may have changed
      location.hash = `#/suivi/${launch.id}`;
    } catch (err) {
      showErrors(err.details);
      formError.replaceChildren(errorBox(err.message));
      submit.disabled = false;
      submit.textContent = 'Lancer';
    }
  };

  const advanced = h(
    'details',
    { class: 'advanced' },
    h('summary', {}, 'Avancé : descriptions, catégories, mots-clés, cahier des charges, options'),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Description du store (10 à 100 caractères)'),
      descFields,
      copyEnglish,
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, h('span', {}, 'Catégories (1 à 3) '), catCount),
      categories,
      errorEl('categories'),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Mots-clés et cahier des charges'),
      field(
        'Mots-clés (séparés par des virgules)',
        h('input', {
          type: 'text',
          value: form.keywords,
          oninput: (e) => {
            form.keywords = e.target.value;
          },
        }),
        {
          hint: `Facultatif. Avec des mots-clés, le manifeste demande Gladys ${s.keywordsMinGladys} minimum (règle du store).`,
          error: errorEl('keywords'),
        },
      ),
      field(
        'Cahier des charges',
        h('textarea', {
          rows: 8,
          oninput: (e) => {
            form.spec = e.target.value;
          },
        }, form.spec),
        { hint: 'Ajouté à CLAUDE.md (section « Objectif ») et à l’issue de suivi.', error: errorEl('spec') },
      ),
    ),
    h('fieldset', {}, h('legend', {}, 'Actions automatiques'), options, simulate),
  );

  setView(
    h('p', {}, h('a', { href: '#/' }, '← Tableau de bord')),
    h('h1', {}, `Lancer ${prefill.displayName || 'une intégration'}`),
    prefill.idea?.description ? h('p', { class: 'muted' }, prefill.idea.description) : null,
    h(
      'form',
      { class: 'launch-form', onsubmit: onSubmit, novalidate: true },
      h(
        'fieldset',
        {},
        h('legend', {}, 'Nom'),
        field('Nom affiché dans Gladys', nameInput, { error: errorEl('displayName') }),
        field('Nom du dépôt GitHub', repoInput, {
          hint: 'Préfixe gladys- + nom, modifiable.',
          error: errorEl('repoName'),
        }),
        preview,
        checkBox,
      ),
      formError,
      h('div', { class: 'form-actions' }, submit),
      h(
        'p',
        { class: 'muted small' },
        'Le reste est rempli depuis le tracker. Claude rédige ensuite les vraies descriptions fr, de et es.',
      ),
      advanced,
    ),
  );
  renderPreview();
  runCheck();
}

// --- follow screen ---------------------------------------------------------------------

const follow = { integ: null, tab: 'lancement', open: new Set(), live: {} };

function linkOrText(href, label, simulated) {
  return simulated ? h('span', { class: 'muted', title: 'Simulation : n’existe pas' }, label) : extLink(href, label);
}

/** Text with its https links made clickable (safe: text nodes + extLink). */
function linkify(text) {
  const parts = String(text ?? '').split(/(https:\/\/[^\s)]+[^\s).,;:])/g);
  return parts.map((part, i) => (i % 2 ? extLink(part, part.replace(/^https:\/\/(www\.)?/, '')) : part));
}

function renderStep(step, integ, { retryPath = `launches/${integ.id}/steps/${step.id}/retry`, busy = integ.status === 'running' } = {}) {
  const lines = step.status === 'running' ? (follow.live[step.id] ?? []) : step.log ?? [];
  const detailsOpen = follow.open.has(step.id) || step.status === 'running';
  const preview = step.data?.preview;
  const checks = step.data?.checks;

  const details = h(
    'details',
    { open: detailsOpen },
    h(
      'summary',
      {
        // Only a click by the user keeps a journal open across refreshes.
        onclick: (e) => {
          if (e.currentTarget.parentElement.open) follow.open.delete(step.id);
          else follow.open.add(step.id);
        },
      },
      `Journal (${lines.length})`,
    ),
    checks ? renderChecks(checks) : null,
    h(
      'pre',
      { class: 'log', dataset: { log: step.id } },
      lines.map((l) => h('span', { class: `log-${l.level}` }, `${new Date(l.t).toLocaleTimeString('fr-FR')}  ${l.message}\n`)),
    ),
    preview
      ? h(
          'div',
          { class: 'files' },
          h('p', { class: 'small muted' }, 'Fichiers qui seraient écrits :'),
          Object.entries(preview).map(([path, content]) =>
            h('details', { class: 'file' }, h('summary', {}, path), h('pre', { class: 'log' }, content)),
          ),
        )
      : null,
  );

  return h(
    'li',
    { class: `step step-${step.status}` },
    h(
      'div',
      { class: 'step-head' },
      statusBadge(step.status),
      h('strong', {}, step.title),
      step.essential ? h('span', { class: 'badge', title: 'Une erreur ici arrête le lancement' }, 'essentielle') : null,
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'button small',
          type: 'button',
          disabled: busy || step.status === 'todo',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api(retryPath, { method: 'POST' });
            } catch (err) {
              alert(err.message);
              e.target.disabled = false;
            }
          },
        },
        'Relancer',
      ),
    ),
    step.message ? h('p', { class: 'step-msg' }, linkify(step.message)) : null,
    step.status !== 'todo' && (lines.length || preview || checks) ? details : null,
  );
}

/** "Publier": one click, then every publication step follows. */
function renderPublish(integ) {
  if (integ.simulate) {
    return h('p', { class: 'muted small' }, 'Simulation : la publication n’est possible que pour un vrai lancement.');
  }
  const publish = integ.publish ?? { status: null, stepList: [] };
  const running = publish.status === 'running';
  const launchOk = ['done', 'warning'].includes(integ.status);
  const button = h(
    'button',
    {
      class: 'button button-primary',
      type: 'button',
      disabled: running || !launchOk || publish.status === 'error',
      title: !launchOk
        ? 'Le lancement doit être terminé'
        : publish.status === 'error'
          ? 'Corrigez le problème puis cliquez sur « Relancer » sur l’étape en erreur'
          : null,
      onclick: async (e) => {
        const again = integ.release ? ` (nouvelle version après la v${integ.release.version})` : '';
        if (
          !confirm(
            `Publier « ${integ.displayName} » dans le store Gladys${again} ?\n\n` +
              'L’appli lance le contrôle du store, la release, vérifie l’image, ajoute le topic officiel, puis suit l’indexeur.',
          )
        ) {
          return;
        }
        e.currentTarget.disabled = true;
        try {
          follow.integ = await api(`launches/${integ.id}/publish`, { method: 'POST' });
          renderFollow();
        } catch (err) {
          alert(err.message);
          e.currentTarget.disabled = false;
        }
      },
    },
    integ.release ? 'Publier une nouvelle version' : 'Publier',
  );
  return h(
    'section',
    { class: 'publish' },
    h(
      'div',
      { class: 'follow-head' },
      h('h2', {}, 'Publication'),
      publish.status ? statusBadge(publish.status, OVERALL_LABELS) : null,
      h('span', { class: 'spacer' }),
      button,
    ),
    publish.status === 'error'
      ? h('p', { class: 'muted small' }, 'Corrigez le problème indiqué, puis cliquez sur « Relancer » sur l’étape en erreur : la publication reprend là où elle s’est arrêtée, sans refaire de version.')
      : null,
    publish.stepList.length
      ? h(
          'ol',
          { class: 'steps' },
          publish.stepList.map((step) =>
            renderStep(step, integ, { retryPath: `launches/${integ.id}/publish/${step.id}/retry`, busy: running }),
          ),
        )
      : h(
          'p',
          { class: 'muted small' },
          'Quand le développement est fusionné sur la branche principale : un clic lance le contrôle du store, la release, la vérification de l’image, le topic officiel et le suivi de l’indexeur.',
        ),
  );
}

function renderFollow() {
  const integ = follow.integ;
  if (!integ) return;
  const sim = Boolean(integ.simulate);
  const links = integ.links ?? {};
  const linkItems = [
    links.repo && linkOrText(links.repo, 'Dépôt', sim),
    links.issue && linkOrText(links.issue, 'Issue de suivi', sim),
    links.actions && linkOrText(links.actions, 'Actions', sim),
    links.codespaces && linkOrText(links.codespaces, 'Ouvrir dans Codespaces', sim),
    links.forum && linkOrText(links.forum, 'Annonce sur le forum', sim),
    links.release && extLink(links.release, `Release v${integ.release?.version ?? ''}`),
  ].filter(Boolean);

  const tabs = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Onglets' },
    h('a', { href: `#/suivi/${integ.id}`, 'aria-current': follow.tab === 'lancement' ? 'page' : null }, 'Lancement'),
    h('a', { href: `#/suivi/${integ.id}/dev`, 'aria-current': follow.tab === 'dev' ? 'page' : null }, 'Développement'),
  );

  if (follow.tab === 'dev') openDevStream(integ.id);
  else closeDevStream();

  const body =
    follow.tab === 'dev'
      ? renderDev()
      : [h('ol', { class: 'steps' }, integ.stepList.map((step) => renderStep(step, integ))), renderPublish(integ)];

  setView(
    h('p', {}, h('a', { href: '#/mes-integrations' }, '← Mes intégrations')),
    h(
      'div',
      { class: 'follow-head' },
      h('h1', {}, integ.displayName),
      statusBadge(integ.status, OVERALL_LABELS),
      sim ? h('span', { class: 'badge badge-warn' }, 'Simulation') : null,
      integ.release ? h('span', { class: 'badge st-done' }, `Publiée v${integ.release.version}`) : null,
    ),
    h('p', { class: 'muted' }, h('code', {}, `${integ.owner}/${integ.repoName}`), ` · lancé le ${formatDate(integ.createdAt)}`),
    linkItems.length ? h('p', { class: 'links' }, linkItems) : null,
    sim && linkItems.length ? h('p', { class: 'muted small' }, 'Simulation : ces liens ne mènent nulle part.') : null,
    tabs,
    body,
  );
}

// --- "Développement" tab ---------------------------------------------------------------

const QUICK_MESSAGES = [
  'Explique ce que tu fais',
  'Ajoute des tests',
  'Fais plus simple',
  'Arrête-toi là et ouvre la PR',
];

const RUN_LABELS = {
  queued: 'En attente',
  in_progress: 'En cours',
  completed: 'Terminée',
  requested: 'Demandée',
  waiting: 'En attente',
  none: 'Pas encore lancée',
};

const CONCLUSIONS = {
  failure: 'Échec',
  cancelled: 'Annulée',
  timed_out: 'Délai dépassé',
  action_required: 'Action requise',
  startup_failure: 'Échec au démarrage',
  skipped: 'Sautée',
  neutral: 'Neutre',
};

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

function runBadge(run) {
  if (!run) return h('span', { class: 'badge' }, 'Aucune');
  if (run.status !== 'completed') return h('span', { class: 'badge st st-running' }, RUN_LABELS[run.status] ?? run.status);
  const ok = run.conclusion === 'success';
  return h('span', { class: `badge st ${ok ? 'st-done' : 'st-error'}` }, ok ? 'Réussie' : (CONCLUSIONS[run.conclusion] ?? run.conclusion));
}

function card(title, ...children) {
  return h('section', { class: 'dev-card' }, h('h2', {}, title), ...children);
}

async function devAction(path, body, button) {
  if (button) button.disabled = true;
  try {
    const res = await api(`launches/${follow.integ.id}/dev/${path}`, { method: 'POST', body });
    if (res.simulated) alert('Mode simulation (DRY_RUN) : rien n’a été envoyé.');
    return res;
  } catch (err) {
    alert(err.message);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Message box: created once, so a draft survives the live refreshes. */
function composeCard() {
  if (follow.compose) return follow.compose;
  const text = h('textarea', { rows: 3, placeholder: 'Votre message à Claude (posté dans l’issue avec @claude)' });
  const send = h(
    'button',
    {
      class: 'button button-primary',
      type: 'button',
      onclick: async (e) => {
        if (!text.value.trim()) return;
        const res = await devAction('message', { text: text.value }, e.currentTarget);
        if (res && !res.simulated) {
          text.value = '';
          sent.textContent = 'Message posté. Claude démarre dans quelques secondes.';
        }
      },
    },
    'Envoyer',
  );
  const sent = h('p', { class: 'small muted' });
  follow.compose = card(
    'Écrire à Claude',
    h(
      'div',
      { class: 'quick' },
      QUICK_MESSAGES.map((m) =>
        h(
          'button',
          {
            class: 'button small',
            type: 'button',
            onclick: () => {
              text.value = m;
              text.focus();
            },
          },
          m,
        ),
      ),
    ),
    text,
    h('div', { class: 'form-actions' }, send),
    sent,
  );
  return follow.compose;
}

function renderDev() {
  follow.devEl ??= h('div', { class: 'dev' });
  const el = follow.devEl;
  const snap = follow.dev;
  if (!snap) {
    el.replaceChildren(follow.devError ? errorBox(follow.devError) : loading('Lecture de GitHub…'));
    return el;
  }
  if (snap.simulated) {
    el.replaceChildren(h('p', { class: 'muted' }, 'Simulation : il n’y a pas de développement réel à suivre.'));
    return el;
  }

  const alerts = snap.alerts.map((a) =>
    h(
      'div',
      { class: `alert ${a.kind === 'limit' ? 'alert-warn' : 'alert-error'} dev-alert` },
      h('strong', {}, a.kind === 'limit' ? 'Limite d’abonnement' : a.kind === 'tests' ? 'Tests en échec' : 'Claude s’est arrêté'),
      ' ',
      a.message,
      ' ',
      a.url ? extLink(a.url, 'Voir l’exécution') : null,
      snap.claudeEnabled && snap.issue
        ? h(
            'div',
            {},
            h(
              'button',
              {
                class: 'button button-primary small',
                type: 'button',
                title: a.kind === 'limit' ? 'À utiliser une fois la limite levée' : null,
                onclick: (e) => devAction('retry', {}, e.currentTarget),
              },
              'Relancer Claude',
            ),
          )
        : null,
    ),
  );

  const plan = snap.plan
    ? card(
        'Plan de Claude',
        h(
          'p',
          {},
          h('span', { class: `badge st ${snap.plan.state === 'finished' ? 'st-done' : snap.plan.state === 'error' ? 'st-error' : 'st-running'}` },
            snap.plan.state === 'finished' ? 'Terminé' : snap.plan.state === 'error' ? 'Erreur' : 'En cours'),
          snap.plan.total ? ` ${snap.plan.done} / ${snap.plan.total} fait` : '',
          ' · ',
          extLink(snap.plan.url, 'voir le commentaire'),
        ),
        snap.plan.total
          ? h('progress', { max: snap.plan.total, value: snap.plan.done, 'aria-label': 'Avancement du plan' })
          : null,
        h(
          'ul',
          { class: 'todo' },
          snap.plan.items.map((i) =>
            h('li', { class: i.done ? 'done' : '' }, h('input', { type: 'checkbox', checked: i.done, disabled: true }), ` ${i.text}`),
          ),
        ),
      )
    : card(
        'Plan de Claude',
        h(
          'p',
          { class: 'muted' },
          snap.claudeEnabled
            ? 'Pas encore de plan : Claude publie son commentaire de suivi dans l’issue au démarrage.'
            : 'Claude n’est pas activé pour cette intégration (pas de jeton Claude au lancement).',
        ),
      );

  const run = snap.claudeRun;
  const runCard = card(
    'Exécution de Claude',
    run
      ? [
          h('p', {}, runBadge(run), ` ${fmtDuration(run.durationMs)} · `, extLink(run.url, 'voir sur GitHub')),
          h(
            'ul',
            { class: 'checks' },
            run.steps.map((st) =>
              h(
                'li',
                { class: `check check-${st.conclusion === 'success' || st.conclusion === 'skipped' ? 'ok' : st.conclusion === 'failure' ? 'ko' : 'unknown'}` },
                h('span', { class: 'check-icon', 'aria-hidden': 'true' }, st.status !== 'completed' ? '…' : st.conclusion === 'failure' ? '✗' : '✓'),
                st.name,
              ),
            ),
          ),
        ]
      : h('p', { class: 'muted' }, 'Aucune exécution de claude.yml pour l’instant.'),
  );

  const pr = snap.pr;
  const ci = snap.ci;
  const ciLine = ci
    ? h(
        'p',
        {},
        'CI : ',
        ci.status === 'none'
          ? h('span', { class: 'badge' }, 'pas encore lancée')
          : ci.status === 'requested'
            ? h('span', { class: 'badge st st-running' }, 'demandée')
            : runBadge(ci),
        ci.url ? [' ', extLink(ci.url, 'détail')] : null,
      )
    : null;
  const prCard = card(
    'Pull request',
    pr
      ? [
          h('p', {}, h('strong', {}, `#${pr.number} `), pr.title, ' ', h('span', { class: `badge st ${pr.state === 'merged' ? 'st-done' : pr.state === 'open' ? 'st-running' : ''}` }, pr.state === 'merged' ? 'fusionnée' : pr.state === 'open' ? (pr.draft ? 'brouillon' : 'ouverte') : 'fermée')),
          ciLine,
          h('p', { class: 'links' }, extLink(pr.url, 'Ouvrir la PR'), extLink(pr.diffUrl, 'Voir le diff')),
        ]
      : [
          h('p', { class: 'muted' }, snap.branch ? 'Pas encore de pull request pour cette branche.' : 'Pas encore de branche de travail.'),
          ciLine,
          snap.branch
            ? h('button', { class: 'button small', type: 'button', onclick: (e) => devAction('pr', {}, e.currentTarget) }, 'Ouvrir la PR')
            : null,
        ],
  );

  const commitsCard = card(
    'Commits et fichiers',
    snap.branch ? h('p', { class: 'small' }, 'Branche ', h('code', {}, snap.branch)) : null,
    snap.commits.length
      ? h(
          'ul',
          { class: 'commits' },
          snap.commits.map((c) =>
            h('li', {}, extLink(c.url, h('code', {}, c.short)), ` ${c.message} `, h('span', { class: 'muted small' }, c.date ? formatDate(c.date) : '')),
          ),
        )
      : h('p', { class: 'muted' }, 'Aucun commit sur une branche de travail.'),
    snap.files.length
      ? [
          h('p', { class: 'small' }, `${snap.files.length} fichier${snap.files.length > 1 ? 's' : ''} · `, h('span', { class: 'plus' }, `+${snap.totals.additions}`), ' ', h('span', { class: 'minus' }, `−${snap.totals.deletions}`)),
          h(
            'ul',
            { class: 'files-list' },
            snap.files.map((f) =>
              h('li', {}, h('code', {}, f.filename), ' ', h('span', { class: 'plus' }, `+${f.additions}`), ' ', h('span', { class: 'minus' }, `−${f.deletions}`)),
            ),
          ),
        ]
      : null,
  );

  const activityCard = card(
    'Fil d’activité',
    snap.activity.length
      ? h(
          'ul',
          { class: 'activity' },
          snap.activity.map((a) =>
            h(
              'li',
              { class: `act act-${a.kind}` },
              h('span', { class: 'muted small' }, formatDate(a.t)),
              ' ',
              a.url ? extLink(a.url, a.text) : a.text,
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Rien pour l’instant.'),
  );

  el.replaceChildren(
    ...alerts,
    ...(follow.devError ? [h('p', { class: 'alert alert-warn' }, `GitHub n’a pas répondu : ${follow.devError}`)] : []),
    h(
      'div',
      { class: 'dev-grid' },
      h('div', { class: 'dev-col' }, plan, runCard, snap.claudeEnabled && snap.issue ? composeCard() : null),
      h('div', { class: 'dev-col' }, prCard, commitsCard, activityCard),
    ),
    h('p', { class: 'muted small', id: 'dev-stamp' }, `Mis à jour à ${fmtTime(snap.updatedAt)} · GitHub est relu toutes les 20 s, seulement quand cette page est ouverte.`),
  );
  return el;
}

function openDevStream(id) {
  if (devStream) return;
  devStream = new EventSource(`api/launches/${encodeURIComponent(id)}/dev/events`);
  devStream.addEventListener('dev', (e) => {
    follow.dev = JSON.parse(e.data);
    follow.devError = null;
    if (follow.tab === 'dev') renderDev();
  });
  devStream.addEventListener('dev-ping', (e) => {
    const { updatedAt } = JSON.parse(e.data);
    if (follow.dev) follow.dev.updatedAt = updatedAt;
    const stamp = document.getElementById('dev-stamp');
    if (stamp) stamp.firstChild.textContent = `Mis à jour à ${fmtTime(updatedAt)} · GitHub est relu toutes les 20 s, seulement quand cette page est ouverte.`;
  });
  devStream.addEventListener('dev-error', (e) => {
    follow.devError = JSON.parse(e.data).message;
    if (follow.tab === 'dev') renderDev();
  });
}

async function showFollow(id, tab) {
  closeStream();
  if (follow.integ?.id !== id) {
    follow.open = new Set();
    follow.live = {};
    follow.integ = null;
    follow.dev = null;
    follow.devError = null;
    follow.devEl = null;
    follow.compose = null;
    setView(loading());
  }
  follow.tab = tab === 'dev' ? 'dev' : 'lancement';
  try {
    follow.integ = await api(`launches/${encodeURIComponent(id)}`);
  } catch (err) {
    setView(errorBox(err.message), h('a', { class: 'button', href: '#/mes-integrations' }, 'Mes intégrations'));
    return;
  }
  renderFollow();

  if (stream) return;
  stream = new EventSource(`api/launches/${encodeURIComponent(id)}/events`);
  stream.addEventListener('launch', (e) => {
    follow.integ = JSON.parse(e.data);
    for (const step of follow.integ.stepList) if (step.status !== 'running') delete follow.live[step.id];
    renderFollow();
  });
  stream.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    (follow.live[entry.step] ??= []).push(entry);
    const pre = document.querySelector(`pre[data-log="${CSS.escape(entry.step)}"]`);
    if (pre) {
      pre.append(
        h('span', { class: `log-${entry.level}` }, `${new Date(entry.t).toLocaleTimeString('fr-FR')}  ${entry.message}\n`),
      );
    } else {
      renderFollow();
    }
  });
}

// --- my integrations ---------------------------------------------------------------------

async function showMine() {
  closeStream();
  setView(h('h1', {}, 'Mes intégrations'), loading());
  let list;
  try {
    list = await api('launches');
  } catch (err) {
    setView(h('h1', {}, 'Mes intégrations'), errorBox(err.message));
    return;
  }
  const rows = list.map((integ) =>
    h(
      'li',
      { class: 'mine-item' },
      h(
        'div',
        { class: 'mine-main' },
        h('a', { href: `#/suivi/${integ.id}`, class: 'mine-name' }, integ.displayName),
        h('span', { class: 'muted small' }, `${integ.owner}/${integ.repoName} · ${formatDate(integ.createdAt)}`),
      ),
      statusBadge(integ.status, OVERALL_LABELS),
      integ.release ? h('span', { class: 'badge st-done' }, `Publiée v${integ.release.version}`) : null,
      integ.publish?.status === 'running' ? h('span', { class: 'badge st st-running' }, 'Publication…') : null,
      integ.simulate ? h('span', { class: 'badge badge-warn' }, 'Simulation') : null,
      integ.simulate
        ? h(
            'button',
            {
              class: 'button small',
              type: 'button',
              onclick: async () => {
                if (!confirm(`Oublier la simulation « ${integ.displayName} » ?`)) return;
                try {
                  await api(`launches/${integ.id}`, { method: 'DELETE' });
                  showMine();
                } catch (err) {
                  alert(err.message);
                }
              },
            },
            'Oublier',
          )
        : null,
    ),
  );
  setView(
    h('h1', {}, 'Mes intégrations'),
    h('div', { id: 'forum-batch' }),
    rows.length
      ? h('ul', { class: 'mine' }, rows)
      : h('p', { class: 'muted' }, 'Aucune intégration lancée pour l’instant. Choisissez une idée libre dans le ', h('a', { href: '#/' }, 'tableau de bord'), '.'),
  );
  renderForumBatch();
}

const BATCH_TEXTS = {
  reserve: {
    title: (n) => `Annonces sur le forum : ${n} intégration${n > 1 ? 's' : ''} à annoncer`,
    intro: 'Le message « Je prends : » réserve les intégrations lancées.',
  },
  release: {
    title: (n) => `Sorties à annoncer sur le forum : ${n} intégration${n > 1 ? 's' : ''} publiée${n > 1 ? 's' : ''}`,
    intro: 'Le message de sortie donne la version et le lien de chaque intégration publiée.',
  },
};

/** One batch message ("Je prends :" or "sorties") for the community topic. */
function batchSection(kind, batch, info) {
  const chosen = new Set(batch.pending.map((p) => p.id));
  const text = h('textarea', { rows: Math.min(14, 4 + batch.pending.length), spellcheck: 'true' });
  text.value = batch.message;
  const result = h('div');
  const post = h(
    'button',
    {
      class: 'button button-primary',
      type: 'button',
      disabled: !info.connected,
      onclick: async (e) => {
        const count = chosen.size;
        if (!count) return;
        if (!confirm(`Poster ce message public dans le sujet des intégrations du forum Gladys (${count} intégration${count > 1 ? 's' : ''}) ?`)) return;
        e.target.disabled = true;
        try {
          const done = await api('forum/batch', { method: 'POST', body: { kind, ids: [...chosen], raw: text.value } });
          if (done.simulated) {
            result.replaceChildren(h('p', { class: 'alert alert-warn' }, 'Mode simulation : rien n’a été posté.'));
            e.target.disabled = false;
          } else {
            showMine();
          }
        } catch (err) {
          result.replaceChildren(errorBox(err.message));
          e.target.disabled = false;
        }
      },
    },
    'Poster sur le forum',
  );
  const texts = BATCH_TEXTS[kind];
  return h(
    'section',
    { class: 'batch' },
    h('h2', {}, texts.title(batch.pending.length)),
    h(
      'p',
      { class: 'muted small' },
      `${texts.intro} On annonce par lot dans `,
      extLink(info.topicUrl, 'le sujet des intégrations candidates'),
      '. Relisez et modifiez le message avant de le poster.',
    ),
    h(
      'div',
      { class: 'options' },
      batch.pending.map((p) =>
        h(
          'label',
          { class: 'check-line' },
          h('input', {
            type: 'checkbox',
            checked: true,
            onchange: (e) => {
              if (e.target.checked) chosen.add(p.id);
              else chosen.delete(p.id);
            },
          }),
          ` ${p.displayName} `,
          h('span', { class: 'muted small' }, p.repo),
        ),
      ),
    ),
    text,
    info.connected
      ? null
      : h('p', { class: 'alert alert-warn' }, 'Connectez d’abord votre compte du forum dans ', h('a', { href: '#/reglages' }, 'Réglages'), '.'),
    result,
    h('div', { class: 'form-actions' }, post),
  );
}

async function renderForumBatch() {
  const host = document.getElementById('forum-batch');
  if (!host) return;
  let info;
  try {
    info = await api('forum/batch');
  } catch (err) {
    host.replaceChildren(errorBox(err.message));
    return;
  }
  host.replaceChildren(
    ...['reserve', 'release'].filter((kind) => info[kind].pending.length).map((kind) => batchSection(kind, info[kind], info)),
  );
}

// --- settings ------------------------------------------------------------------------------

function secretField(label, name, isSet, hint, values) {
  const input = h('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: isSet ? 'Réglée : laissez vide pour la garder' : 'Non réglée',
    oninput: (e) => {
      values[name] = e.target.value;
    },
  });
  const clear = h(
    'button',
    {
      class: 'button small',
      type: 'button',
      disabled: !isSet,
      onclick: () => {
        values[name] = null;
        input.value = '';
        input.placeholder = 'Sera effacée à l’enregistrement';
      },
    },
    'Effacer',
  );
  return field(h('span', {}, `${label} `, h('span', { class: `badge ${isSet ? 'st-done' : ''}` }, isSet ? 'réglée' : 'non réglée')), h('span', { class: 'row' }, input, clear), { hint });
}

async function showSettings() {
  closeStream();
  setView(h('h1', {}, 'Réglages'), loading());
  let settings;
  try {
    settings = await api('settings');
  } catch (err) {
    setView(h('h1', {}, 'Réglages'), errorBox(err.message));
    return;
  }
  const s = state.status;
  const values = {};
  const text = (name, props = {}) =>
    h('input', {
      type: 'text',
      value: settings[name] ?? '',
      oninput: (e) => {
        values[name] = e.target.value;
      },
      ...props,
    });
  const message = h('div');

  const onSubmit = async (e) => {
    e.preventDefault();
    message.replaceChildren();
    try {
      await api('settings', { method: 'PUT', body: values });
      state.status = await api('status');
      showSettings();
    } catch (err) {
      message.replaceChildren(errorBox(err.message));
    }
  };

  setView(
    h('h1', {}, 'Réglages'),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Version'),
      h('dd', {}, s.version),
      h('dt', {}, 'Jeton GitHub (.env)'),
      h('dd', {}, s.githubTokenSet ? 'Réglé' : 'Non réglé : ajoutez GITHUB_TOKEN dans .env'),
      h('dt', {}, 'Mode simulation (DRY_RUN)'),
      h('dd', {}, s.dryRun ? 'Oui' : 'Non'),
      h('dt', {}, 'Cache des sources'),
      h('dd', {}, `${s.cacheMinutes} min`),
    ),
    tokenCheckBox(),
    h(
      'form',
      { class: 'launch-form', onsubmit: onSubmit },
      h(
        'fieldset',
        {},
        h('legend', {}, 'GitHub'),
        field('Compte ou organisation cible', text('owner', { placeholder: s.owner ? `${s.owner} (propriétaire du jeton)` : 'ex. mon-compte' }), {
          hint: 'Vide = le compte du jeton GitHub.',
        }),
        field('Topics en plus', text('extraTopics', { placeholder: 'ex. domotique, zigbee' }), {
          hint: 'Ajoutés aux dépôts, en plus de gladys-integration-wip.',
        }),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Claude (abonnement Pro ou Max)'),
        secretField('Jeton Claude', 'claudeToken', settings.claudeTokenSet, 'Créé avec « claude setup-token ». Jamais réaffiché.', values),
        field(
          'Nombre de tours maximum par exécution',
          h('input', {
            type: 'number',
            min: 1,
            max: 200,
            value: settings.claudeMaxTurns ?? '',
            placeholder: '40',
            oninput: (e) => {
              values.claudeMaxTurns = e.target.value;
            },
          }),
          { hint: 'Pour ménager les limites de l’abonnement.' },
        ),
      ),
      forumFieldset(settings, values),
      message,
      h('div', { class: 'form-actions' }, h('button', { class: 'button button-primary', type: 'submit' }, 'Enregistrer')),
    ),
  );
}

/**
 * Forum account: Discourse User API Key, by copy/paste (no callback URL,
 * nothing exposed on the Internet).
 */
function forumFieldset(settings, values) {
  const box = h('fieldset', {}, h('legend', {}, 'Forum Gladys'));
  const status = h('div');
  box.append(status);

  const refresh = async () => {
    state.status = await api('status');
    showSettings();
  };

  if (settings.forumConnected) {
    status.append(
      h(
        'p',
        { class: 'alert alert-ok' },
        `Connecté en tant que ${settings.forumUsername || '(inconnu)'}.`,
      ),
      h(
        'button',
        {
          class: 'button small',
          type: 'button',
          onclick: async (e) => {
            if (!confirm('Déconnecter le compte du forum ? La clé sera révoquée sur le forum.')) return;
            e.target.disabled = true;
            await api('forum/disconnect', { method: 'POST' }).catch((err) => alert(err.message));
            refresh();
          },
        },
        'Déconnecter',
      ),
    );
  } else {
    const error = h('div');
    const link = h('p');
    const paste = h('textarea', { rows: 4, placeholder: 'Collez ici le code affiché par le forum', spellcheck: 'false' });
    const validate = h(
      'button',
      {
        class: 'button button-primary small',
        type: 'button',
        onclick: async (e) => {
          error.replaceChildren();
          e.target.disabled = true;
          try {
            await api('forum/complete', { method: 'POST', body: { payload: paste.value } });
            refresh();
          } catch (err) {
            error.replaceChildren(errorBox(err.message));
            e.target.disabled = false;
          }
        },
      },
      'Valider le code',
    );
    const step2 = h(
      'div',
      { class: 'field', hidden: !settings.forumPending },
      h('span', { class: 'field-label' }, '2. Collez le code affiché par le forum'),
      paste,
      h('div', {}, validate),
      error,
    );
    const open = h(
      'button',
      {
        class: 'button small',
        type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const { url } = await api('forum/connect', { method: 'POST' });
            link.replaceChildren(
              h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'button button-primary small' }, 'Ouvrir le forum et autoriser'),
            );
            step2.hidden = false;
          } catch (err) {
            error.replaceChildren(errorBox(err.message));
          }
          e.target.disabled = false;
        },
      },
      settings.forumPending ? 'Recommencer la connexion' : 'Connecter mon compte du forum',
    );
    status.append(
      h(
        'p',
        { class: 'muted small' },
        'Chacun utilise son propre compte : l’appli demande au forum une clé personnelle (lecture et écriture). ' +
          'Aucune adresse de retour : rien n’est exposé sur Internet.',
      ),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '1. Autoriser l’appli sur le forum'), h('div', {}, open), link),
      step2,
    );
  }

  box.append(
    h(
      'p',
      { class: 'muted small' },
      'Les lancements sont annoncés par lot, dans un seul message « Je prends : » du sujet des intégrations candidates. ' +
        'Le message se prépare et se poste depuis « Mes intégrations ».',
    ),
  );
  return box;
}

// --- router --------------------------------------------------------------------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  const nav = {
    '': 'dashboard',
    lancer: 'dashboard',
    'mes-integrations': 'mine',
    suivi: 'mine',
    reglages: 'settings',
  }[page];
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.toggleAttribute('aria-current', a.dataset.nav === nav);
  });
  if (page !== 'suivi') closeStream();
  if (page === 'lancer') return showLaunch(decodeURIComponent(rest.join('/')));
  if (page === 'suivi') return showFollow(decodeURIComponent(rest[0] ?? ''), rest[1]);
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
