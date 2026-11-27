// -----------------------------------------------------------------------------
// The launch steps. Each one can be run again without breaking anything
// (it checks what already exists first). A failing essential step stops the
// launch; a failing non-essential step only gives a warning.
//
// ctx: { integ, gh, dryRun, config, settings, secrets, repoSettings, deps,
//        template: { owner, repo }, log(message), db }
// A step returns { status?: 'done' | 'warning' | 'skipped', message, data? }.
// -----------------------------------------------------------------------------

import { sealSecret } from '../crypto.js';
import { checkName } from './checks.js';
import { SOURCE_FILES, buildFiles, dockerImage } from './files.js';
import { forumPost, issueBody, issueTitle } from './texts.js';
import { createTopic, topicTitle } from '../sources/forum.js';
import { parseTopics } from '../settings.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sim = (ctx) => (ctx.dryRun ? 'Simulation : ' : '');
const repoPath = (integ) => `/repos/${integ.owner}/${integ.repoName}`;
const repoUrl = (integ) => `https://github.com/${integ.owner}/${integ.repoName}`;

function setLinks(integ) {
  const url = repoUrl(integ);
  integ.links = {
    ...integ.links,
    repo: url,
    actions: `${url}/actions`,
    codespaces: `https://codespaces.new/${integ.owner}/${integ.repoName}`,
  };
}

// --- 1. name ---------------------------------------------------------------------

async function stepCheckName(ctx) {
  const { integ } = ctx;
  if (integ.repoCreated) {
    return { message: 'Nom déjà réservé : le dépôt a été créé par ce lancement.' };
  }
  const report = await checkName(
    {
      displayName: integ.displayName,
      repoName: integ.repoName,
      owner: integ.owner,
      ideaKey: integ.ideaKey,
      ownForumTopicId: integ.forumTopicId,
    },
    ctx.deps,
  );
  for (const c of report.checks) {
    ctx.log(`${c.label} : ${c.ok === true ? 'OK' : c.ok === false ? 'PRIS' : 'inconnu'} — ${c.message}`);
  }
  if (report.conflicts) {
    const taken = report.checks.filter((c) => c.ok === false).map((c) => `${c.label} (${c.message})`);
    throw new Error(`Nom déjà pris : ${taken.join(' ; ')}`);
  }
  if (report.unknown) {
    if (report.checks.find((c) => c.source === 'github').ok !== true) {
      throw new Error('Impossible de vérifier GitHub : le dépôt pourrait déjà exister.');
    }
    return { status: 'warning', message: 'Nom libre, mais une source n’a pas pu être vérifiée.', data: report };
  }
  return { message: 'Nom libre partout (tracker, store, forum, GitHub).', data: report };
}

// --- 2. repository -----------------------------------------------------------------

async function copyTemplateWithGitData(ctx, template) {
  const { gh, integ } = ctx;
  const t = `/repos/${ctx.template.owner}/${ctx.template.repo}`;
  const tree = await gh.get(`${t}/git/trees/${template.default_branch}?recursive=1`);
  if (tree.truncated) throw new Error('Arbre du modèle trop grand pour être copié par l’API.');
  const blobs = tree.tree.filter((e) => e.type === 'blob');
  ctx.log(`Copie du modèle par l’API Git Data : ${blobs.length} fichiers`);

  const owner = await gh.get(`/users/${integ.owner}`);
  const createPath = owner.type === 'Organization' ? `/orgs/${integ.owner}/repos` : '/user/repos';
  const { data: repo } = await gh.post(
    createPath,
    { name: integ.repoName, description: integ.description.en, private: false, auto_init: true },
    { simulate: () => ({ html_url: repoUrl(integ), default_branch: 'main' }) },
  );
  integ.defaultBranch = repo.default_branch || 'main';
  if (ctx.dryRun) return;

  integ.repoCreated = true;
  await ctx.saveInteg();
  const head = await waitForBranch(ctx, integ.defaultBranch);

  const entries = [];
  for (const blob of blobs) {
    const source = await gh.get(`${t}/git/blobs/${blob.sha}`);
    const { data } = await gh.post(`${repoPath(integ)}/git/blobs`, {
      content: source.content.replace(/\n/g, ''),
      encoding: 'base64',
    });
    entries.push({ path: blob.path, mode: blob.mode, type: 'blob', sha: data.sha });
  }
  const { data: newTree } = await gh.post(`${repoPath(integ)}/git/trees`, { tree: entries });
  const { data: commit } = await gh.post(`${repoPath(integ)}/git/commits`, {
    message: `Initial commit from ${ctx.template.owner}/${ctx.template.repo}`,
    tree: newTree.sha,
    parents: [head],
  });
  await gh.patch(`${repoPath(integ)}/git/refs/heads/${integ.defaultBranch}`, { sha: commit.sha, force: true });
}

async function stepCreateRepo(ctx) {
  const { gh, integ } = ctx;
  if (integ.repoCreated && (await gh.exists(repoPath(integ)))) {
    setLinks(integ);
    return { message: `Dépôt déjà créé : ${repoUrl(integ)}` };
  }
  if (!ctx.dryRun && (await gh.exists(repoPath(integ)))) {
    throw new Error(`Le dépôt ${integ.owner}/${integ.repoName} existe déjà (pas créé par ce lancement).`);
  }

  const t = `/repos/${ctx.template.owner}/${ctx.template.repo}`;
  const template = await gh.get(t);
  integ.templateBranch = template.default_branch;

  if (template.is_template) {
    const { data } = await gh.post(
      `${t}/generate`,
      {
        owner: integ.owner,
        name: integ.repoName,
        description: integ.description.en,
        include_all_branches: false,
        private: false,
      },
      { simulate: () => ({ html_url: repoUrl(integ), default_branch: template.default_branch }) },
    );
    integ.defaultBranch = data.default_branch || template.default_branch;
    ctx.log(`Dépôt généré depuis le modèle ${ctx.template.owner}/${ctx.template.repo}`);
  } else {
    ctx.log('Le dépôt modèle n’est pas marqué « template » sur GitHub : copie par l’API Git Data');
    await copyTemplateWithGitData(ctx, template);
  }
  if (!ctx.dryRun) integ.repoCreated = true;
  setLinks(integ);
  return {
    message: `${ctx.dryRun ? 'Simulation : dépôt public créé' : 'Dépôt public créé'} : ${repoUrl(integ)}`,
  };
}

// --- 3. default branch ---------------------------------------------------------------

async function waitForBranch(ctx, branch) {
  const deadline = Date.now() + ctx.config.branchWaitMs;
  for (let attempt = 1; ; attempt += 1) {
    const { status, data } = await ctx.gh.request(
      'GET',
      `${repoPath(ctx.integ)}/git/ref/heads/${encodeURIComponent(branch)}`,
      { allow: [404, 409] },
    );
    if (status === 200) return data.object.sha;
    if (Date.now() > deadline) {
      throw new Error(`La branche ${branch} n’existe toujours pas après ${Math.round(ctx.config.branchWaitMs / 1000)} s.`);
    }
    if (attempt === 1) ctx.log(`Attente de la branche ${branch}…`);
    await sleep(ctx.config.branchPollMs);
  }
}

async function stepWaitBranch(ctx) {
  const branch = ctx.integ.defaultBranch || 'main';
  if (ctx.dryRun) return { message: `Simulation : branche ${branch} considérée comme prête.` };
  const sha = await waitForBranch(ctx, branch);
  return { message: `Branche ${branch} prête (${sha.slice(0, 7)}).` };
}

// --- 4. personalization commit ---------------------------------------------------------

async function stepCustomize(ctx) {
  const { gh, integ } = ctx;
  const branch = integ.defaultBranch || 'main';
  // In simulation the repository does not exist: read the template instead.
  const [owner, repo, readRef] = ctx.dryRun
    ? [ctx.template.owner, ctx.template.repo, integ.templateBranch || branch]
    : [integ.owner, integ.repoName, branch];

  const sources = {};
  for (const path of SOURCE_FILES) sources[path] = await gh.readFile(owner, repo, path, readRef);

  const current = sources['gladys-assistant-integration.json']
    ? JSON.parse(sources['gladys-assistant-integration.json'])
    : null;
  if (
    !ctx.dryRun &&
    current?.name === integ.displayName &&
    current?.docker_image === dockerImage(integ.owner, integ.repoName, current.version)
  ) {
    return { message: 'Déjà personnalisé (manifeste à jour).' };
  }

  const { files } = buildFiles(integ, sources, branch);
  const list = Object.entries(files).map(([path, content]) => ({ path, size: Buffer.byteLength(content) }));
  for (const f of list) ctx.log(`${f.path} (${f.size} octets)`);

  if (ctx.dryRun) {
    const preview = Object.fromEntries(Object.entries(files).filter(([path]) => path !== 'package-lock.json'));
    return {
      message: `Simulation : un commit de ${list.length} fichiers serait poussé sur ${branch}.`,
      data: { files: list, preview },
    };
  }

  const base = `${repoPath(integ)}/git`;
  const ref = await gh.get(`${base}/ref/heads/${encodeURIComponent(branch)}`);
  const parent = await gh.get(`${base}/commits/${ref.object.sha}`);
  const { data: tree } = await gh.post(`${base}/trees`, {
    base_tree: parent.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
  });
  const { data: commit } = await gh.post(`${base}/commits`, {
    message: `Personalize the integration: ${integ.displayName}\n\nGenerated by External Integration Creator.`,
    tree: tree.sha,
    parents: [ref.object.sha],
  });
  await gh.patch(`${base}/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
  return { message: `Commit ${commit.sha.slice(0, 7)} : ${list.length} fichiers personnalisés.`, data: { files: list, commit: commit.sha } };
}

// --- 5 to 10. repository settings ---------------------------------------------------------

async function stepRepoSettings(ctx) {
  await ctx.gh.patch(repoPath(ctx.integ), ctx.repoSettings.repository ?? {});
  return { message: `${ctx.dryRun ? 'Simulation : réglages' : 'Réglages'} appliqués (config/repo-settings.json).` };
}

async function stepSecurity(ctx) {
  const wanted = ctx.repoSettings.security ?? {};
  const calls = [
    ['vulnerability_alerts', 'vulnerability-alerts', 'alertes de vulnérabilité'],
    ['automated_security_fixes', 'automated-security-fixes', 'correctifs automatiques'],
    ['private_vulnerability_reporting', 'private-vulnerability-reporting', 'signalement privé'],
  ];
  const failed = [];
  for (const [key, path, label] of calls) {
    if (wanted[key] === false) continue;
    try {
      await ctx.gh.put(`${repoPath(ctx.integ)}/${path}`);
      if (!ctx.dryRun) ctx.log(`Activé : ${label}`);
    } catch (err) {
      failed.push(`${label} (${err.message})`);
    }
  }
  if (failed.length) return { status: 'warning', message: `Non activé : ${failed.join(' ; ')}` };
  return { message: `${sim(ctx)}Alertes, correctifs automatiques et signalement privé activés.` };
}

async function stepActionsPermissions(ctx) {
  const body = ctx.repoSettings.actions ?? {
    default_workflow_permissions: 'read',
    can_approve_pull_request_reviews: true,
  };
  await ctx.gh.put(`${repoPath(ctx.integ)}/actions/permissions/workflow`, body);
  return {
    message: `${sim(ctx)}Jeton des workflows : ${body.default_workflow_permissions}, approbation des PR autorisée.`,
  };
}

async function stepTopics(ctx) {
  const { gh, integ } = ctx;
  const cfg = ctx.repoSettings.topics ?? {};
  const wip = cfg.wip ?? 'gladys-integration-wip';
  const official = cfg.official ?? 'gladys-assistant-integration';
  let existing = [];
  if (!ctx.dryRun) existing = (await gh.get(`${repoPath(integ)}/topics`)).names ?? [];
  const names = [
    ...new Set([...existing, wip, ...(cfg.extra ?? []), ...parseTopics(ctx.settings.extraTopics)]),
  ]
    .filter((t) => t !== official) // not yet: the store would index an empty integration
    .slice(0, 20);
  await gh.put(`${repoPath(integ)}/topics`, { names });
  return { message: `${sim(ctx)}Topics : ${names.join(', ')}` };
}

async function stepWatch(ctx) {
  await ctx.gh.put(`${repoPath(ctx.integ)}/subscription`, { subscribed: true, ignored: false });
  return { message: `${sim(ctx)}Dépôt suivi (Watch).` };
}

async function stepLabels(ctx) {
  const labels = ctx.repoSettings.labels ?? [];
  for (const label of labels) {
    const { status } = await ctx.gh.post(`${repoPath(ctx.integ)}/labels`, label, { allow: [422] });
    if (status === 422) {
      await ctx.gh.patch(`${repoPath(ctx.integ)}/labels/${encodeURIComponent(label.name)}`, {
        color: label.color,
        description: label.description,
      });
      ctx.log(`Étiquette mise à jour : ${label.name}`);
    } else if (!ctx.dryRun) {
      ctx.log(`Étiquette créée : ${label.name}`);
    }
  }
  return { message: `${sim(ctx)}Étiquettes : ${labels.map((l) => l.name).join(', ')}` };
}

// --- 11. Claude secret ------------------------------------------------------------------------

async function stepClaudeSecret(ctx) {
  const token = ctx.secrets.claudeToken;
  if (!ctx.integ.claude || !token) {
    return { status: 'skipped', message: 'Sautée : aucun jeton Claude réglé.' };
  }
  const path = `${repoPath(ctx.integ)}/actions/secrets`;
  if (ctx.dryRun) {
    ctx.log(`Simulation : GET ${path}/public-key puis chiffrement libsodium`);
    await ctx.gh.put(`${path}/CLAUDE_CODE_OAUTH_TOKEN`, {});
    return { message: 'Simulation : secret CLAUDE_CODE_OAUTH_TOKEN enregistré.' };
  }
  const key = await ctx.gh.get(`${path}/public-key`);
  const encrypted = await sealSecret(key.key, token);
  await ctx.gh.put(`${path}/CLAUDE_CODE_OAUTH_TOKEN`, { encrypted_value: encrypted, key_id: key.key_id });
  return { message: 'Secret CLAUDE_CODE_OAUTH_TOKEN enregistré (chiffré).' };
}

// --- 12. forum topic --------------------------------------------------------------------------

async function stepForumTopic(ctx) {
  const { integ } = ctx;
  const auth = { key: ctx.secrets.forumUserApiKey, clientId: ctx.secrets.forumClientId };
  if (!auth.key) {
    return { status: 'skipped', message: 'Sautée : compte du forum non connecté (Réglages).' };
  }
  if (integ.forumTopicId) return { message: `Sujet déjà créé : ${integ.links?.forum}` };

  const title = topicTitle(integ.displayName);
  const existing = await ctx.deps.forumSearch(integ.displayName);
  const same = existing.find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
  if (same) throw new Error(`Un sujet « ${same.title} » existe déjà : ${same.url}`);

  const categoryId = ctx.settings.forumCategoryId || ctx.repoSettings.forum?.category_id || null;
  if (ctx.dryRun) {
    ctx.log(`Simulation : POST ${ctx.config.forumUrl}/posts.json « ${title} » (catégorie ${categoryId ?? 'par défaut'})`);
    return { message: `Simulation : sujet « ${title} » créé.` };
  }
  const topic = await createTopic(ctx.config, auth, {
    categoryId,
    title,
    raw: forumPost({ ...integ, repoUrl: repoUrl(integ) }),
  });
  integ.forumTopicId = topic.id;
  integ.links = { ...integ.links, forum: topic.url };
  return { message: `Sujet créé : ${topic.url}` };
}

// --- 13. tracking issue -----------------------------------------------------------------------

async function stepTrackingIssue(ctx) {
  const { gh, integ } = ctx;
  if (integ.issueNumber && !ctx.dryRun) {
    const { status } = await gh.request('GET', `${repoPath(integ)}/issues/${integ.issueNumber}`, { allow: [404] });
    if (status === 200) return { message: `Issue déjà créée : #${integ.issueNumber}` };
  }
  const claude = Boolean(integ.claude && ctx.secrets.claudeToken);
  const labels = ['en cours', ...(claude ? ['claude'] : [])];
  const { data } = await gh.post(
    `${repoPath(integ)}/issues`,
    {
      title: issueTitle(integ.displayName),
      body: issueBody({ ...integ, claude, forumUrl: integ.links?.forum }),
      labels,
    },
    { simulate: () => ({ number: 1, html_url: `${repoUrl(integ)}/issues/1` }) },
  );
  if (!ctx.dryRun) integ.issueNumber = data.number;
  integ.links = { ...integ.links, issue: data.html_url };
  return {
    message: `${ctx.dryRun ? 'Simulation : issue' : 'Issue'} #${data.number} créée${claude ? ', Claude est sollicité (@claude)' : ''}.`,
  };
}

// --- 14. local reservation ---------------------------------------------------------------------

async function stepReservation(ctx) {
  const { integ } = ctx;
  const repo = `${integ.owner}/${integ.repoName}`;
  if (ctx.dryRun) return { message: `Simulation : ${integ.displayName} n’est pas réservée (rien n’a été créé).` };
  await ctx.db.update((state) => {
    state.reservations = state.reservations.filter((r) => r.integrationId !== integ.id && r.repo !== repo);
    state.reservations.push({
      integrationId: integ.id,
      ideaKey: integ.ideaKey ?? null,
      name: integ.displayName,
      repo,
      categories: integ.categories,
      createdAt: new Date().toISOString(),
    });
  });
  ctx.onReservation?.();
  return { message: 'L’idée passe « En cours » dans l’appli, en attendant le tracker.' };
}

// --- list -----------------------------------------------------------------------------------------

/**
 * option: key of the form checkbox that enables the step (always on when absent).
 */
export const STEPS = [
  { id: 'check-name', title: 'Vérifier que le nom est libre', essential: true, run: stepCheckName },
  { id: 'create-repo', title: 'Créer le dépôt public', essential: true, run: stepCreateRepo },
  { id: 'wait-branch', title: 'Attendre la branche par défaut', essential: true, run: stepWaitBranch },
  { id: 'customize', title: 'Personnaliser (un seul commit)', essential: true, run: stepCustomize },
  { id: 'repo-settings', title: 'Réglages du dépôt', option: 'settings', run: stepRepoSettings },
  { id: 'security', title: 'Sécurité', option: 'security', run: stepSecurity },
  { id: 'actions', title: 'Permissions des Actions', option: 'actionsPermissions', run: stepActionsPermissions },
  { id: 'topics', title: 'Topics', option: 'topics', run: stepTopics },
  { id: 'watch', title: 'Suivre le dépôt (Watch)', option: 'watch', run: stepWatch },
  { id: 'labels', title: 'Étiquettes', option: 'labels', run: stepLabels },
  { id: 'claude-secret', title: 'Secret Claude', option: 'claude', run: stepClaudeSecret },
  { id: 'forum', title: 'Sujet sur le forum', option: 'forum', run: stepForumTopic },
  { id: 'issue', title: 'Issue de suivi', option: 'issue', run: stepTrackingIssue },
  { id: 'reservation', title: 'Réservation locale', essential: true, run: stepReservation },
];

export const OPTIONS = [
  { key: 'settings', label: 'Appliquer les réglages du dépôt (squash, auto-merge, détection des secrets…)' },
  { key: 'security', label: 'Activer les alertes et correctifs de sécurité' },
  { key: 'actionsPermissions', label: 'Régler les permissions des GitHub Actions' },
  { key: 'topics', label: 'Ajouter les topics (gladys-integration-wip…)' },
  { key: 'watch', label: 'Suivre le dépôt (Watch)' },
  { key: 'labels', label: 'Créer les étiquettes claude, en cours, publication' },
  { key: 'claude', label: 'Confier le développement à Claude (workflow, secret, @claude)' },
  { key: 'forum', label: 'Créer le sujet « Intégration externe » sur le forum' },
  { key: 'issue', label: 'Créer l’issue de suivi avec la check-list' },
];
