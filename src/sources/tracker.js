// -----------------------------------------------------------------------------
// Community tracker (william-de71.github.io/gladys-integrations-tracker).
// It is the main source: its detection is NOT redone here, its statuses are
// taken as they are. Columns are located by their header name, so a reordered
// file still works; a missing required column raises a clear error.
// -----------------------------------------------------------------------------

import { parseCsv } from './csv.js';
import { fetchText } from '../http.js';
import { mapTrackerCategories } from '../categories.js';
import { nameKeys, normalizeName } from '../names.js';

export const IDEAS_FILE = 'liste-ha-gladys.csv';
export const INTEGRATIONS_FILE = 'integrations-gladys.csv';

export class TrackerFormatError extends Error {
  constructor(file, missing, found) {
    super(
      `Le format du tracker a changé : ${file} n'a plus la ou les colonnes ` +
        `${missing.map((m) => `« ${m} »`).join(', ')}. ` +
        `Colonnes trouvées : ${found.join(', ') || '(aucune)'}.`,
    );
    this.name = 'TrackerFormatError';
    this.file = file;
    this.missing = missing;
  }
}

// field -> { header names accepted (first one is the reference), required }
const IDEA_COLUMNS = {
  id: { names: ['N°', 'No', 'Numéro', 'Id'], required: true },
  name: { names: ['Intégration Home Assistant', 'Intégration HA', 'Nom'], required: true },
  status: { names: ['Statut Gladys', 'Statut'], required: true },
  prio: { names: ['Prio', 'Priorité'] },
  category: { names: ['Catégorie', 'Catégories'] },
  usage: { names: ['Usage HA'] },
  access: { names: ['Accès'] },
  noHardware: { names: ['Sans matériel'] },
  docUrl: { names: ['Doc HA / HACS', 'Doc HA', 'Documentation'] },
  gladysName: { names: ['Intégration Gladys'] },
  author: { names: ['Auteur'] },
  repoUrl: { names: ['Dépôt GitHub', 'Dépôt'] },
  description: { names: ['Description HA', 'Description'] },
  installs: { names: ['Installations HA'] },
  seenAt: { names: ['Vu chez'] },
};

const INTEGRATION_COLUMNS = {
  name: { names: ['Intégration Gladys', 'Nom'], required: true },
  status: { names: ['Statut', 'Statut Gladys'], required: true },
  author: { names: ['Auteur'] },
  repoUrl: { names: ['Dépôt GitHub', 'Dépôt'] },
  cover: { names: ['Cover', 'Couverture'] },
  type: { names: ['Type'] },
  version: { names: ['Version'] },
  lastPush: { names: ['Dernier push'] },
  haRef: { names: ['Équivalent HA (liste)', 'Équivalent HA'] },
  description: { names: ['Description'] },
};

const headerKey = (h) => normalizeName(h);

/** Maps each field to its column index; throws TrackerFormatError if a required one is missing. */
export function mapColumns(file, header, columns) {
  const index = new Map(header.map((h, i) => [headerKey(h), i]));
  const map = {};
  const missing = [];
  for (const [field, spec] of Object.entries(columns)) {
    const i = spec.names.map(headerKey).find((k) => index.has(k));
    if (i !== undefined) map[field] = index.get(i);
    else if (spec.required) missing.push(spec.names[0]);
  }
  if (missing.length) throw new TrackerFormatError(file, missing, header);
  return map;
}

function readRows(file, text, columns) {
  const rows = parseCsv(text);
  if (!rows.length) throw new TrackerFormatError(file, Object.keys(columns), []);
  const map = mapColumns(file, rows[0], columns);
  return rows.slice(1).map((row) => {
    const out = {};
    for (const [field, i] of Object.entries(map)) out[field] = (row[i] ?? '').trim();
    return out;
  });
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** "https://github.com/Owner/Repo" -> "Owner/Repo" */
export function repoFullName(url) {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(String(url ?? ''));
  return match ? `${match[1]}/${match[2].replace(/\.git$/, '')}` : null;
}

/**
 * Column of the dashboard for a tracker status. Unknown statuses go to
 * "exists" (flagged): never offer to launch something we cannot interpret.
 */
export function bucketOfStatus(status) {
  const s = String(status ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (/^\s*libre\b/.test(s)) return { bucket: 'free', known: true };
  if (/en cours|annoncee/.test(s)) return { bucket: 'progress', known: true };
  if (/publiee|native|topic store|hors store|archivee|depreciee|supprimee/.test(s)) {
    return { bucket: 'exists', known: true };
  }
  return { bucket: 'exists', known: false };
}

export function parseIdeas(text) {
  return readRows(IDEAS_FILE, text, IDEA_COLUMNS)
    .filter((r) => r.id && r.name)
    .map((r) => {
      const { bucket, known } = bucketOfStatus(r.status);
      return {
        key: `idea:${r.id}`,
        id: r.id,
        name: r.name,
        status: r.status,
        bucket,
        unknownStatus: !known,
        prio: r.prio || '',
        rawCategory: r.category || '',
        categories: mapTrackerCategories(r.category),
        usage: r.usage || '',
        access: r.access && r.access !== '—' ? r.access : '',
        noHardware: /^oui|yes|x$/i.test(r.noHardware || ''),
        docUrl: httpUrl(r.docUrl),
        gladysName: r.gladysName || '',
        author: r.author || '',
        repo: repoFullName(r.repoUrl),
        description: r.description || '',
        installs: Number.parseInt(r.installs, 10) || 0,
        seenAt: r.seenAt || '',
        source: 'tracker',
      };
    });
}

export function parseIntegrations(text) {
  return readRows(INTEGRATIONS_FILE, text, INTEGRATION_COLUMNS)
    .filter((r) => r.name)
    .map((r) => {
      const { bucket, known } = bucketOfStatus(r.status);
      const repo = repoFullName(r.repoUrl);
      const haRef = /^\s*([A-Z]?\d+)\b/.exec(r.haRef || '')?.[1] ?? null;
      return {
        key: `gladys:${repo ? repo.toLowerCase() : normalizeName(r.name)}`,
        name: r.name,
        status: r.status,
        bucket,
        unknownStatus: !known,
        author: r.author || '',
        repo,
        cover: httpUrl(r.cover),
        type: r.type || '',
        version: r.version || '',
        lastPush: r.lastPush || '',
        haRef,
        description: r.description || '',
        source: 'gladys',
      };
    });
}

const BUCKET_RANK = { free: 0, progress: 1, exists: 2 };

/**
 * Builds the three dashboard columns from the tracker data and the local
 * reservations ([{ ideaKey, name, repo, createdAt }]).
 */
export function buildBoard({ ideas, integrations }, reservations = []) {
  const ideaById = new Map(ideas.map((i) => [i.id, { ...i, notes: [] }]));
  const items = [...ideaById.values()];

  // Name index of everything that already exists or is in progress.
  const takenByKey = new Map();
  const remember = (name, entry) => {
    for (const k of nameKeys(name)) if (!takenByKey.has(k)) takenByKey.set(k, entry);
  };

  for (const integ of integrations) {
    const idea = integ.haRef ? ideaById.get(integ.haRef) : null;
    remember(integ.name, integ);
    if (integ.repo) remember(integ.repo.split('/')[1], integ);
    if (idea) {
      idea.repo ||= integ.repo;
      idea.author ||= integ.author;
      idea.gladysName ||= integ.name;
      // The integrations list is more precise than the ideas list: never
      // show as free an idea that already has a repository.
      if (BUCKET_RANK[integ.bucket] > BUCKET_RANK[idea.bucket]) {
        idea.notes.push(`Le tracker indique « ${idea.status} », mais l'intégration liée est « ${integ.status} »`);
        idea.bucket = integ.bucket;
        idea.status = integ.status;
      }
    } else {
      items.push({ ...integ, categories: [], notes: [] });
    }
  }

  // A free idea whose name matches an existing integration is not free.
  for (const idea of ideaById.values()) {
    if (idea.bucket !== 'free') continue;
    const hit = nameKeys(idea.name)
      .map((k) => takenByKey.get(k))
      .find(Boolean);
    if (hit) {
      idea.notes.push(`Le tracker indique « ${idea.status} », mais le nom correspond à l'intégration « ${hit.name} »`);
      idea.bucket = hit.bucket === 'free' ? 'progress' : hit.bucket;
      idea.status = hit.status;
      idea.repo ||= hit.repo;
    }
  }

  // Local reservations: launched here, not yet seen by the tracker.
  for (const reservation of reservations) {
    const id = reservation.ideaKey?.startsWith('idea:') ? reservation.ideaKey.slice(5) : null;
    const idea = id ? ideaById.get(id) : null;
    if (idea) {
      if (idea.bucket === 'free') {
        idea.bucket = 'progress';
        idea.status = 'Lancée depuis cette appli';
        idea.reservedLocally = true;
        idea.repo ||= reservation.repo;
        idea.notes.push('Lancée depuis cette appli (en attente du tracker)');
      }
    } else if (!items.some((i) => i.repo && i.repo.toLowerCase() === reservation.repo?.toLowerCase())) {
      items.push({
        key: `local:${reservation.repo}`,
        name: reservation.name,
        status: 'Lancée depuis cette appli',
        bucket: 'progress',
        reservedLocally: true,
        repo: reservation.repo,
        categories: reservation.categories ?? [],
        notes: ['En attente de la prochaine mise à jour du tracker'],
        source: 'local',
      });
    }
  }

  const columns = { exists: [], progress: [], free: [] };
  for (const item of items) columns[item.bucket].push(item);
  return {
    columns,
    counts: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length])),
  };
}

/** Downloads and parses both CSV files. */
export async function fetchTracker(config) {
  const base = config.trackerBaseUrl;
  const opts = { timeoutMs: config.httpTimeoutMs };
  const [ideasText, integrationsText] = await Promise.all([
    fetchText(`${base}/${IDEAS_FILE}`, opts),
    fetchText(`${base}/${INTEGRATIONS_FILE}`, opts),
  ]);
  return { ideas: parseIdeas(ideasText), integrations: parseIntegrations(integrationsText) };
}
