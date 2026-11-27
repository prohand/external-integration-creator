// -----------------------------------------------------------------------------
// Re-checks, right before (and while) launching, that nobody took the name:
// the tracker can be 30 minutes late. Sources: tracker board, store catalog,
// forum topics "Intégration externe - X", and GitHub (the repository must 404).
// -----------------------------------------------------------------------------

import { namesMatch } from '../names.js';

const LABELS = {
  tracker: 'Tracker communautaire',
  store: 'Store Gladys',
  forum: 'Forum',
  github: 'GitHub',
};

function result(source, ok, message, link) {
  return { source, label: LABELS[source], ok, message, link: link ?? null };
}

const repoPart = (fullName) => String(fullName ?? '').split('/').pop();

async function safely(source, fn) {
  try {
    return await fn();
  } catch (err) {
    return result(source, null, `Vérification impossible : ${err.message}`);
  }
}

/**
 * @param {object} target - { displayName, repoName, owner, ideaKey, ownRepo, ownForumTopicId }
 *   ownRepo: the repository was created by this launch (it may exist).
 * @param {object} deps - { board(), storeIndex(), forumSearch(term), github }
 */
export async function checkName(target, deps) {
  const { displayName, repoName, owner, ideaKey } = target;
  const fullName = owner && repoName ? `${owner}/${repoName}` : null;
  const isOurs = (repo) => fullName && repo && repo.toLowerCase() === fullName.toLowerCase();
  const sameName = (name) => namesMatch(name, displayName) || namesMatch(name, repoName);

  const checks = await Promise.all([
    safely('tracker', async () => {
      const board = await deps.board();
      const taken = [...board.columns.exists, ...board.columns.progress].filter(
        (item) => !isOurs(item.repo) && (item.key === ideaKey || sameName(item.name) || (item.repo && sameName(repoPart(item.repo)))),
      );
      if (taken.length) {
        const t = taken[0];
        return result('tracker', false, `« ${t.name} » : ${t.status}`, t.repo ? `https://github.com/${t.repo}` : t.docUrl);
      }
      return result('tracker', true, 'Libre dans le tracker');
    }),

    safely('store', async () => {
      const index = await deps.storeIndex();
      const hit = index.find(
        (e) =>
          !isOurs(e.slug) &&
          (sameName(e.name) || sameName(repoPart(e.slug)) || e.keywords.some((k) => namesMatch(k, displayName))),
      );
      return hit
        ? result('store', false, `Déjà dans le store : « ${hit.name} » (${hit.slug})`, hit.repoUrl)
        : result('store', true, 'Absente du store');
    }),

    safely('forum', async () => {
      const topics = await deps.forumSearch(displayName);
      const hit = topics.find((t) => t.id !== target.ownForumTopicId && sameName(t.name));
      return hit
        ? result('forum', false, `Sujet existant : « ${hit.title} »`, hit.url)
        : result('forum', true, 'Aucun sujet « Intégration externe » à ce nom');
    }),

    safely('github', async () => {
      if (!fullName) return result('github', null, 'Compte GitHub cible non réglé (page Réglages)');
      const exists = await deps.github.exists(`/repos/${fullName}`);
      if (!exists) return result('github', true, `${fullName} est disponible`);
      if (target.ownRepo) return result('github', true, `${fullName} a été créé par ce lancement`, `https://github.com/${fullName}`);
      return result('github', false, `Le dépôt ${fullName} existe déjà`, `https://github.com/${fullName}`);
    }),
  ]);

  return {
    checks,
    conflicts: checks.filter((c) => c.ok === false).length,
    unknown: checks.filter((c) => c.ok === null).length,
    free: checks.every((c) => c.ok === true),
  };
}
