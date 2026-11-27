// -----------------------------------------------------------------------------
// Publication steps ("Publier" button): store checks, release, public image,
// official topic, store indexer, forum announcement. Like the launch steps,
// each one can be run again: a workflow run already started is followed
// instead of being started twice.
// -----------------------------------------------------------------------------

import { fetchJson } from '../http.js';
import { fetchRejected, fetchStoreIndex } from '../sources/store.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repoPath = (integ) => `/repos/${integ.owner}/${integ.repoName}`;
const minutes = (ms) => Math.round(ms / 60_000);

const RUN_STATUS = {
  queued: 'en file d’attente',
  waiting: 'en attente',
  requested: 'demandée',
  pending: 'en attente',
  in_progress: 'en cours',
  completed: 'terminée',
};

/**
 * Follows a workflow run until it ends: the given run, or the first run of
 * `workflow` started by a dispatch after `since`. `onRun(run)` is called once
 * the run is known, so a retry follows it instead of starting another one.
 */
async function waitForRun(ctx, { workflow, since, runId, label, timeoutMs, onRun }) {
  const repo = repoPath(ctx.integ);
  const deadline = Date.now() + timeoutMs;
  let run = runId ? await ctx.gh.get(`${repo}/actions/runs/${runId}`) : null;
  let lastStatus = null;
  for (;;) {
    if (!run) {
      const runs = (await ctx.gh.get(`${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`))
        .workflow_runs ?? [];
      run = runs.find((r) => new Date(r.created_at) >= new Date(since) - 60_000) ?? null;
      if (run) {
        ctx.log(`${label} : ${run.html_url}`);
        await onRun?.(run);
      }
    } else if (run.status !== 'completed') {
      run = await ctx.gh.get(`${repo}/actions/runs/${run.id}`);
    }
    if (run && run.status !== lastStatus) {
      ctx.log(`${label} : ${RUN_STATUS[run.status] ?? run.status}`);
      lastStatus = run.status;
    }
    if (run?.status === 'completed') return run;
    if (Date.now() > deadline) {
      throw new Error(
        `${label} : pas terminé après ${minutes(timeoutMs)} min. Relancez cette étape pour continuer à attendre.`,
      );
    }
    await sleep(ctx.config.publishPollMs);
  }
}

/** Lines "[error] …" / "[warning] …" of the failed (or every) job logs of a run. */
async function reportLines(ctx, run, { onlyFailed = true } = {}) {
  const repo = repoPath(ctx.integ);
  const jobs = (await ctx.gh.get(`${repo}/actions/runs/${run.id}/jobs`)).jobs ?? [];
  const lines = [];
  for (const job of jobs.filter((j) => !onlyFailed || j.conclusion === 'failure')) {
    const log = await ctx.gh
      .request('GET', `${repo}/actions/jobs/${job.id}/logs`, { raw: true, accept: '*/*' })
      .then((r) => String(r.data ?? ''))
      .catch(() => '');
    for (const raw of log.split('\n')) {
      const line = raw.replace(/^\S+Z\s/, '').trim();
      if (/^\[(error|warning)\]/i.test(line)) lines.push(line);
    }
  }
  return { jobs, lines: [...new Set(lines)] };
}

function failedSteps(jobs) {
  return jobs
    .filter((j) => j.conclusion === 'failure')
    .map((j) => {
      const step = (j.steps ?? []).find((s) => s.conclusion === 'failure');
      return `${j.name}${step ? ` → ${step.name}` : ''}`;
    })
    .join(' ; ');
}

// --- 1. ready to publish? ---------------------------------------------------------------

async function stepReady(ctx) {
  const { gh, integ } = ctx;
  const repo = repoPath(integ);
  const branch = integ.defaultBranch || 'main';
  const pulls = await gh.get(`${repo}/pulls?state=open&per_page=20`);
  const open = pulls.find((p) => p.head?.ref?.startsWith('claude/')) ?? pulls.find((p) => !/dependabot/i.test(p.user?.login ?? ''));
  if (open) {
    throw new Error(`La pull request #${open.number} n’est pas fusionnée : fusionnez-la d’abord (${open.html_url}).`);
  }
  const [head] = await gh.get(`${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`);
  const personalization = integ.steps?.customize?.data?.commit;
  if (head && personalization && head.sha === personalization) {
    throw new Error(
      `Rien n’a encore été développé sur ${branch} : publier maintenant mettrait le code de démonstration du modèle dans le store.`,
    );
  }
  return { message: `Branche ${branch} prête (${head?.sha?.slice(0, 7) ?? '?'} : ${String(head?.commit?.message ?? '').split('\n')[0]}).` };
}

// --- 2. store checks ------------------------------------------------------------------------

async function stepStoreCheck(ctx) {
  const { gh, integ } = ctx;
  const attempt = integ.publishAttempt;
  const branch = integ.defaultBranch || 'main';
  let since = null;
  if (!attempt.storeCheckRunId) {
    since = new Date().toISOString();
    try {
      await gh.post(`${repoPath(integ)}/actions/workflows/store-check.yml/dispatches`, { ref: branch });
    } catch (err) {
      if (err.status === 404) throw new Error('Le workflow store-check.yml est absent du dépôt.');
      throw err;
    }
  }
  const run = await waitForRun(ctx, {
    workflow: 'store-check.yml',
    since,
    runId: attempt.storeCheckRunId,
    label: 'Contrôle du store',
    timeoutMs: ctx.config.storeCheckTimeoutMs,
    onRun: async (r) => {
      attempt.storeCheckRunId = r.id;
      await ctx.saveInteg();
    },
  });
  if (run.conclusion === 'success') {
    const { lines } = await reportLines(ctx, run, { onlyFailed: false });
    const warnings = lines.filter((l) => /^\[warning\]/i.test(l));
    for (const w of warnings) ctx.log(w, 'warn');
    return { message: `Contrôle du store réussi${warnings.length ? ` (${warnings.length} avertissement${warnings.length > 1 ? 's' : ''}, voir le journal)` : ''}.` };
  }
  // Next try starts a new check (after a fix).
  delete attempt.storeCheckRunId;
  const { lines } = await reportLines(ctx, run);
  for (const l of lines) ctx.log(l, /^\[error\]/i.test(l) ? 'error' : 'warn');
  const errors = lines.filter((l) => /^\[error\]/i.test(l));
  throw new Error(
    errors.length
      ? `Le store refuserait l’intégration : ${errors.map((e) => e.replace(/^\[error\]\s*/i, '')).join(' ; ')}`
      : `Le contrôle du store a échoué : ${run.html_url}`,
  );
}

// --- 3. release ---------------------------------------------------------------------------------

async function stepRelease(ctx) {
  const { gh, integ } = ctx;
  const attempt = integ.publishAttempt;
  const repo = repoPath(integ);
  const branch = integ.defaultBranch || 'main';
  const releaseType = ctx.repoSettings.publish?.release_type ?? 'minor';
  let since = null;

  if (attempt.releaseRunId) {
    const previous = await gh.get(`${repo}/actions/runs/${attempt.releaseRunId}`);
    if (previous.status === 'completed' && previous.conclusion !== 'success') {
      // Same version: re-run the failed jobs instead of bumping again.
      await gh.post(`${repo}/actions/runs/${previous.id}/rerun-failed-jobs`, {});
      ctx.log('Relance des jobs en échec de la release (même version)');
      await sleep(ctx.config.publishPollMs);
    }
  } else {
    since = new Date().toISOString();
    try {
      await gh.post(`${repo}/actions/workflows/release.yml/dispatches`, {
        ref: branch,
        inputs: { 'release-type': releaseType },
      });
    } catch (err) {
      if (err.status === 404) throw new Error('Le workflow release.yml est absent du dépôt.');
      throw err;
    }
    ctx.log(`Release « ${releaseType} » demandée`);
  }

  const run = await waitForRun(ctx, {
    workflow: 'release.yml',
    since,
    runId: attempt.releaseRunId,
    label: 'Release',
    timeoutMs: ctx.config.releaseTimeoutMs,
    onRun: async (r) => {
      attempt.releaseRunId = r.id;
      await ctx.saveInteg();
    },
  });
  if (run.conclusion !== 'success') {
    const jobs = (await gh.get(`${repo}/actions/runs/${run.id}/jobs`)).jobs ?? [];
    throw new Error(`La release a échoué (${failedSteps(jobs) || run.conclusion}) : ${run.html_url}. « Relancer » relance les jobs en échec.`);
  }

  const manifest = JSON.parse((await gh.readFile(integ.owner, integ.repoName, 'gladys-assistant-integration.json', branch)) ?? '{}');
  integ.release = { version: manifest.version, image: manifest.docker_image, runUrl: run.html_url, at: new Date().toISOString() };
  integ.links = { ...integ.links, release: `https://github.com/${integ.owner}/${integ.repoName}/releases/tag/v${manifest.version}` };
  return { message: `Version ${manifest.version} publiée (image ${manifest.docker_image}).` };
}

// --- 4. public image ---------------------------------------------------------------------------

/** True when the image can be pulled without an account (anonymous token). */
export async function isImagePublic(config, image) {
  const match = /^ghcr\.io\/([^:]+):(.+)$/.exec(String(image ?? ''));
  if (!match) throw new Error(`Image inattendue : ${image}`);
  const [, path, tag] = match;
  const base = config.ghcrUrl;
  let token;
  try {
    token = (await fetchJson(`${base}/token?scope=repository:${path}:pull&service=ghcr.io`, { timeoutMs: config.httpTimeoutMs })).token;
  } catch (err) {
    if ([401, 403, 404].includes(err.status)) return false;
    throw err;
  }
  const res = await fetch(`${base}/v2/${path}/manifests/${encodeURIComponent(tag)}`, {
    method: 'HEAD',
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
    signal: AbortSignal.timeout(config.httpTimeoutMs),
  });
  if (res.ok) return true;
  if ([401, 403, 404].includes(res.status)) return false;
  throw new Error(`ghcr.io a répondu ${res.status}`);
}

async function stepImage(ctx) {
  const { integ } = ctx;
  const image = integ.release?.image;
  if (!image) throw new Error('Pas de release : relancez d’abord l’étape Release.');
  if (await isImagePublic(ctx.config, image)) return { message: `${image} se télécharge sans compte.` };
  const owner = await ctx.gh.get(`/users/${integ.owner}`).catch(() => ({ type: 'User' }));
  const scope = owner.type === 'Organization' ? 'orgs' : 'users';
  const settings = `https://github.com/${scope}/${integ.owner}/packages/container/${integ.repoName.toLowerCase()}/settings`;
  integ.links = { ...integ.links, packageSettings: settings };
  throw new Error(
    `L’image ${image} n’est pas téléchargeable sans compte. Rendez le paquet public (Danger Zone → Change visibility → Public) : ${settings} puis cliquez sur « Relancer ».`,
  );
}

// --- 5. official topic ------------------------------------------------------------------------

async function stepTopic(ctx) {
  const { gh, integ } = ctx;
  const cfg = ctx.repoSettings.topics ?? {};
  const wip = cfg.wip ?? 'gladys-integration-wip';
  const official = cfg.official ?? 'gladys-assistant-integration';
  const current = (await gh.get(`${repoPath(integ)}/topics`)).names ?? [];
  const names = [official, ...current.filter((t) => t !== wip && t !== official)].slice(0, 20);
  await gh.put(`${repoPath(integ)}/topics`, { names });
  return { message: `Topic ${official} ajouté, ${wip} retiré : l’indexeur du store peut la trouver.` };
}

// --- 6. store indexer ----------------------------------------------------------------------------

async function stepIndexer(ctx) {
  const { integ } = ctx;
  const slug = `${integ.owner}/${integ.repoName}`.toLowerCase();
  const since = integ.publishAttempt?.startedAt ?? 0;
  const rejected = (await fetchRejected(ctx.config)) ?? [];
  const refusal = (Array.isArray(rejected) ? rejected : []).find(
    (r) => String(r.store_slug).toLowerCase() === slug && new Date(r.checked_at) >= new Date(since),
  );
  if (refusal) {
    return { status: 'warning', message: `L’indexeur du store refuse l’intégration : ${refusal.reason}` };
  }
  const index = await fetchStoreIndex(ctx.config);
  const entry = index.find((e) => e.slug.toLowerCase() === slug);
  if (entry) {
    integ.links = { ...integ.links, store: `${ctx.config.storeBaseUrl}/integrations/${slug.replace('/', '--')}.json` };
    return { message: `Visible dans le store${entry.version ? ` en ${entry.version}` : ''}.` };
  }
  return {
    status: 'warning',
    message: 'Pas encore dans le store : l’indexeur n’est pas encore passé. Cliquez sur « Relancer » plus tard pour vérifier.',
  };
}

// --- 7. forum announcement (batched) -----------------------------------------------------------

async function stepForumRelease(ctx) {
  const { integ } = ctx;
  if (integ.forum?.released?.version === integ.release?.version) {
    return { message: `Sortie déjà annoncée (message n° ${integ.forum.released.postNumber}).` };
  }
  integ.forum = { ...integ.forum, releaseQueuedAt: new Date().toISOString() };
  return { message: 'Ajoutée au prochain message « sorties » du forum : à poster depuis « Mes intégrations ».' };
}

export const PUBLISH_STEPS = [
  { id: 'pub-ready', title: 'Vérifier que tout est prêt', essential: true, run: stepReady },
  { id: 'pub-store-check', title: 'Contrôle du store', essential: true, run: stepStoreCheck },
  { id: 'pub-release', title: 'Release (nouvelle version)', essential: true, run: stepRelease },
  { id: 'pub-image', title: 'Image téléchargeable sans compte', essential: true, run: stepImage },
  { id: 'pub-topic', title: 'Topic officiel du store', essential: true, run: stepTopic },
  { id: 'pub-indexer', title: 'Indexeur du store', run: stepIndexer },
  { id: 'pub-forum', title: 'Annonce de la sortie (par lot)', run: stepForumRelease },
];
