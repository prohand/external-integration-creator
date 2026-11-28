// -----------------------------------------------------------------------------
// GitHub token check. Fine-grained tokens cannot list their own permissions,
// so each one is probed on an existing repository of the target account with
// a request that can never change anything:
//   - an invalid payload: 422 (or 404) = allowed, 403 = permission missing;
//   - a read: 200 = allowed.
// GitHub checks the permission before validating the payload.
// -----------------------------------------------------------------------------

import { PERMISSIONS } from './github.js';

const STATUS = { ok: 'ok', missing: 'missing', unknown: 'unknown' };

/** True when GitHub refused for lack of token permission. */
function isPermissionDenied(err) {
  if (err.status !== 403) return false;
  return Boolean(err.permission) || /not accessible by (personal access|integration)/i.test(err.message);
}

async function probe(fn) {
  try {
    await fn();
    return STATUS.ok;
  } catch (err) {
    if (isPermissionDenied(err)) return STATUS.missing;
    if ([404, 409, 410, 422].includes(err.status)) return STATUS.ok; // allowed, payload refused
    return STATUS.unknown;
  }
}

/** A repository of the target account the token can reach, for the probes. */
async function probeRepo(gh, owner, ownerType) {
  const path =
    ownerType === 'Organization'
      ? `/orgs/${owner}/repos?per_page=20&sort=updated`
      : `/users/${owner}/repos?per_page=20&sort=updated`;
  const repos = await gh.get(path);
  return Array.isArray(repos) ? repos.find((r) => !r.archived && !r.fork) ?? repos[0] ?? null : null;
}

/**
 * @returns {Promise<object>} { ok, login, owner, tokenType, expiresAt, repo, permissions: [...], message }
 */
export async function checkToken(gh, { owner: wantedOwner } = {}) {
  if (!gh.token) {
    return { ok: false, message: 'Aucun jeton : collez-le dans Réglages (ou GITHUB_TOKEN dans .env).', permissions: [] };
  }
  let me;
  let headers;
  try {
    const res = await gh.request('GET', '/user');
    me = res.data;
    headers = res.headers;
  } catch (err) {
    return { ok: false, message: err.message, permissions: [] };
  }

  const tokenType = gh.token.startsWith('github_pat_') ? 'fine-grained' : gh.token.startsWith('ghp_') ? 'classic' : 'autre';
  const expiration = headers.get('github-authentication-token-expiration');
  const report = {
    login: me.login,
    owner: wantedOwner || me.login,
    tokenType,
    expiresAt: expiration ? new Date(expiration.replace(' UTC', 'Z').replace(' ', 'T')).toISOString() : null,
    permissions: [],
  };

  // Classic token: the scopes are in a header.
  if (tokenType === 'classic') {
    const scopes = (headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const need = [
      ['repo', 'créer et régler les dépôts, issues, secrets'],
      ['workflow', 'ajouter les workflows .github/workflows'],
    ];
    report.permissions = need.map(([scope, use]) => ({
      key: scope,
      label: `Scope ${scope}`,
      level: '',
      use,
      status: scopes.includes(scope) ? STATUS.ok : STATUS.missing,
    }));
    report.message = 'Jeton classique : un jeton fine-grained est recommandé (droits plus limités).';
    report.ok = report.permissions.every((p) => p.status === STATUS.ok);
    return report;
  }

  let ownerType = 'User';
  try {
    ownerType = (await gh.get(`/users/${report.owner}`)).type;
  } catch (err) {
    return { ...report, ok: false, message: `Compte cible « ${report.owner} » introuvable : ${err.message}` };
  }
  const repo = await probeRepo(gh, report.owner, ownerType).catch(() => null);
  const r = repo ? `/repos/${repo.full_name}` : null;
  report.repo = repo?.full_name ?? null;

  const checks = [
    ['metadata', 'read', () => gh.get(r)],
    // Invalid topic name: 422 when allowed, nothing is changed.
    ['administration', 'write', () => gh.put(`${r}/topics`, { names: ['Invalid Topic Name!'] })],
    // Invalid ref name: 422 when allowed, no ref is created.
    ['contents', 'write', () => gh.post(`${r}/git/refs`, { ref: 'invalid', sha: '0' })],
    // Issue without title: 422 when allowed, no issue is created.
    ['issues', 'write', () => gh.post(`${r}/issues`, {})],
    // Re-run of a run that does not exist: 404 when allowed.
    ['actions', 'write', () => gh.post(`${r}/actions/runs/1/rerun`, {})],
    ['secrets', 'read', () => gh.get(`${r}/actions/secrets/public-key`)],
    ['watching', 'read', () => gh.get('/user/subscriptions?per_page=1')],
  ];

  for (const [key, level, fn] of checks) {
    const info = PERMISSIONS[key];
    const needsRepo = key !== 'watching';
    const status = needsRepo && !r ? STATUS.unknown : await probe(fn);
    report.permissions.push({ key, label: info.label, level, use: info.use, status });
  }
  // Not testable without writing: checked by the first launch.
  for (const key of ['workflows', 'secrets']) {
    report.permissions.push({
      key: `${key}-write`,
      label: PERMISSIONS[key].label,
      level: 'write',
      use: PERMISSIONS[key].use,
      status: STATUS.unknown,
      note: 'Écriture vérifiable seulement au premier lancement.',
    });
  }

  const missing = report.permissions.filter((p) => p.status === STATUS.missing);
  report.ok = missing.length === 0;
  report.message = !r
    ? `Aucun dépôt de ${report.owner} pour tester les droits : ils seront vérifiés au premier lancement.`
    : missing.length
      ? `Droits manquants : ${missing.map((p) => p.label).join(', ')}.`
      : `Droits testés sur ${repo.full_name} sans rien modifier.`;
  return report;
}
