// -----------------------------------------------------------------------------
// Live development follow-up: what Claude (or anyone) is doing in the new
// repository, read from the GitHub API. No webhook: the app polls GitHub,
// only while a "Développement" page is open (see DevMonitor).
// -----------------------------------------------------------------------------

const CI_WORKFLOW = '.github/workflows/ci.yml';
const MAX_ACTIVITY = 60;
const STOPPED = { failure: 'échec', cancelled: 'annulé', timed_out: 'délai dépassé' };

// --- parsing helpers (pure, tested) ---------------------------------------------------

/**
 * Claude's tracking comment (claude-code-action): state, todo list, branch.
 * Returns null when the comment is not Claude's tracking comment.
 */
export function parseTrackingComment(body) {
  const text = String(body ?? '');
  const heading = /\*\*Claude (finished|encountered an error|is working|Code is working)[^*]*\*\*/i.exec(text);
  if (!heading) return null;
  const word = heading[1].toLowerCase();
  const state = word === 'finished' ? 'finished' : word.startsWith('encountered') ? 'error' : 'working';
  const items = [...text.matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/gm)].map((m) => ({
    done: m[1].toLowerCase() === 'x',
    text: m[2].replace(/<[^>]+>/g, '').trim(),
  }));
  const branch = /\/tree\/([^\s)]+)\)/.exec(text)?.[1];
  const createPr = /\[Create PR[^\]]*\]\((https:\/\/[^)\s]+)\)/i.exec(text)?.[1] ?? null;
  return {
    state,
    title: heading[0].replace(/\*/g, ''),
    items,
    done: items.filter((i) => i.done).length,
    total: items.length,
    branch: branch ? decodeURIComponent(branch) : null,
    createPrUrl: createPr,
  };
}

/** "Claude AI usage limit reached|1749924000" and friends, in a job log. */
export function detectUsageLimit(log) {
  const text = String(log ?? '');
  const withReset = /usage limit reached\|(\d{10})/i.exec(text);
  if (withReset) return { resetAt: new Date(Number(withReset[1]) * 1000).toISOString() };
  if (/(usage|rate) limit (reached|exceeded)|limit will reset|out of (usage|extra usage)|5-hour limit|weekly limit/i.test(text)) {
    return { resetAt: null };
  }
  return null;
}

const durationMs = (start, end) => (start ? Math.max(0, new Date(end ?? Date.now()) - new Date(start)) : null);

function runView(run, jobs = []) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion ?? null,
    startedAt: run.run_started_at ?? run.created_at,
    updatedAt: run.updated_at,
    durationMs: durationMs(run.run_started_at ?? run.created_at, run.status === 'completed' ? run.updated_at : null),
    url: run.html_url,
    event: run.event,
    steps: jobs.flatMap((job) =>
      (job.steps ?? []).map((st) => ({ job: job.name, name: st.name, status: st.status, conclusion: st.conclusion ?? null })),
    ),
  };
}

// --- snapshot ---------------------------------------------------------------------------

/**
 * Reads the development state of `integ` on GitHub.
 * @param {import('../github.js').GitHub} gh
 * @param {object} memo - per-integration memory (logs already read, CI dispatched…)
 */
export async function devSnapshot(gh, integ, memo = {}) {
  const repo = `/repos/${integ.owner}/${integ.repoName}`;
  const base = integ.defaultBranch || 'main';
  const snap = {
    updatedAt: new Date().toISOString(),
    claudeEnabled: Boolean(integ.claude),
    issue: integ.issueNumber ? { number: integ.issueNumber, url: integ.links?.issue ?? null } : null,
    plan: null,
    claudeRun: null,
    branch: null,
    commits: [],
    files: [],
    totals: { additions: 0, deletions: 0 },
    pr: null,
    ci: null,
    alerts: [],
    activity: [],
  };
  const activity = [];

  // 1. Issue comments: Claude's plan, messages.
  let comments = [];
  if (integ.issueNumber) {
    comments = await gh.get(`${repo}/issues/${integ.issueNumber}/comments?per_page=100`);
    const tracking = [...comments].reverse().find((c) => c.user?.type === 'Bot' && parseTrackingComment(c.body));
    if (tracking) snap.plan = { ...parseTrackingComment(tracking.body), url: tracking.html_url, updatedAt: tracking.updated_at };
    for (const c of comments) {
      if (c === tracking) continue;
      const bot = c.user?.type === 'Bot';
      activity.push({
        t: c.created_at,
        kind: bot ? 'claude' : 'message',
        text: bot ? `Réponse de Claude : ${excerpt(c.body)}` : `Message de ${c.user?.login ?? '?'} : ${excerpt(c.body)}`,
        url: c.html_url,
      });
    }
  }

  // 2. Claude's last run (workflow claude.yml).
  const claudeRuns = await gh
    .get(`${repo}/actions/workflows/claude.yml/runs?per_page=5`)
    .then((d) => d.workflow_runs ?? [])
    .catch((err) => (err.status === 404 ? [] : Promise.reject(err)));
  const lastRun = claudeRuns[0];
  if (lastRun) {
    const jobs = (await gh.get(`${repo}/actions/runs/${lastRun.id}/jobs`)).jobs ?? [];
    snap.claudeRun = runView(lastRun, jobs);
    if (lastRun.conclusion === 'failure') {
      const limit = await usageLimitOf(gh, repo, jobs, memo);
      snap.alerts.push(
        limit
          ? {
              kind: 'limit',
              message: `Limite d’abonnement Claude atteinte${limit.resetAt ? ` : réessayez après ${new Date(limit.resetAt).toLocaleString('fr-FR')}` : ''}.`,
              resetAt: limit.resetAt,
              url: lastRun.html_url,
            }
          : { kind: 'claude-error', message: 'La dernière exécution de Claude a échoué.', url: lastRun.html_url },
      );
    }
  }
  for (const run of claudeRuns) {
    activity.push({ t: run.run_started_at ?? run.created_at, kind: 'run', text: 'Claude a démarré', url: run.html_url });
    if (run.status === 'completed') {
      const label = run.conclusion === 'success' ? 'Claude a terminé' : `Claude s’est arrêté (${STOPPED[run.conclusion] ?? run.conclusion})`;
      activity.push({ t: run.updated_at, kind: run.conclusion === 'success' ? 'run' : 'error', text: label, url: run.html_url });
    }
  }

  // 3. Pull request and branch.
  const pulls = await gh.get(`${repo}/pulls?state=all&per_page=20&sort=created&direction=desc`);
  const pr =
    pulls.find((p) => snap.plan?.branch && p.head?.ref === snap.plan.branch) ??
    pulls.find((p) => p.head?.ref?.startsWith('claude/'));
  let branch = pr?.head?.ref ?? snap.plan?.branch ?? null;
  if (!branch) {
    const branches = await gh.get(`${repo}/branches?per_page=100`);
    branch = branches.map((b) => b.name).filter((n) => n.startsWith('claude/')).sort().at(-1) ?? null;
  }
  snap.branch = branch;
  if (pr) {
    snap.pr = {
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state,
      draft: Boolean(pr.draft),
      url: pr.html_url,
      diffUrl: `${pr.html_url}/files`,
      createdAt: pr.created_at,
    };
    activity.push({ t: pr.created_at, kind: 'pr', text: `Pull request #${pr.number} ouverte : ${pr.title}`, url: pr.html_url });
    if (pr.merged_at) activity.push({ t: pr.merged_at, kind: 'pr', text: `Pull request #${pr.number} fusionnée`, url: pr.html_url });
  }

  // 4. Commits and files of the branch.
  if (branch && branch !== base) {
    const cmp = await gh
      .get(`${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`)
      .catch((err) => (err.status === 404 ? null : Promise.reject(err)));
    if (cmp) {
      snap.commits = (cmp.commits ?? [])
        .map((c) => ({
          sha: c.sha,
          short: c.sha.slice(0, 7),
          message: String(c.commit?.message ?? '').split('\n')[0],
          date: c.commit?.author?.date ?? c.commit?.committer?.date ?? null,
          author: c.commit?.author?.name ?? '',
          url: c.html_url,
        }))
        .reverse();
      snap.files = (cmp.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));
      snap.totals = snap.files.reduce(
        (t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
        { additions: 0, deletions: 0 },
      );
      for (const c of snap.commits) activity.push({ t: c.date, kind: 'commit', text: `Commit ${c.short} : ${c.message}`, url: c.url });
    }
  }

  // 5. CI on the head of the branch (or of the PR).
  const headSha = pr?.state === 'open' ? pr.head?.sha : snap.commits[0]?.sha;
  if (headSha) {
    const runs = (await gh.get(`${repo}/actions/runs?head_sha=${headSha}&per_page=20`)).workflow_runs ?? [];
    const ci = runs.find((r) => r.path?.startsWith(CI_WORKFLOW));
    if (ci) {
      snap.ci = { ...runView(ci), headSha, failures: [] };
      if (ci.conclusion === 'failure') {
        const jobs = (await gh.get(`${repo}/actions/runs/${ci.id}/jobs`)).jobs ?? [];
        snap.ci.failures = jobs
          .filter((j) => j.conclusion === 'failure')
          .map((j) => {
            const step = (j.steps ?? []).find((st) => st.conclusion === 'failure');
            return { job: j.name, step: step?.name ?? null, url: j.html_url ?? ci.html_url };
          });
        snap.alerts.push({
          kind: 'tests',
          message: `CI en échec : ${snap.ci.failures.map((f) => `${f.job}${f.step ? ` → ${f.step}` : ''}`).join(' ; ') || 'voir le détail'}.`,
          url: ci.html_url,
        });
      }
      if (ci.status === 'completed') {
        activity.push({
          t: ci.updated_at,
          kind: ci.conclusion === 'success' ? 'ci' : 'error',
          text: ci.conclusion === 'success' ? `CI réussie sur ${headSha.slice(0, 7)}` : `CI en échec sur ${headSha.slice(0, 7)}`,
          url: ci.html_url,
        });
      }
    } else {
      snap.ci = { status: 'none', headSha, failures: [] };
    }
  }

  snap.activity = activity
    .filter((a) => a.t)
    .sort((a, b) => String(b.t).localeCompare(String(a.t)))
    .slice(0, MAX_ACTIVITY);
  return snap;
}

function excerpt(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** Reads the logs of a failed Claude run (once per job) to find a usage limit. */
async function usageLimitOf(gh, repo, jobs, memo) {
  memo.logs ??= new Map();
  for (const job of jobs.filter((j) => j.conclusion === 'failure')) {
    if (!memo.logs.has(job.id)) {
      const log = await gh
        .request('GET', `${repo}/actions/jobs/${job.id}/logs`, { raw: true, accept: '*/*' })
        .then((r) => String(r.data ?? '').slice(-200_000))
        .catch(() => '');
      memo.logs.set(job.id, detectUsageLimit(log));
    }
    const found = memo.logs.get(job.id);
    if (found) return found;
  }
  return null;
}

/**
 * Pushes from GITHUB_TOKEN do not start other workflows: the CI of Claude's
 * branch is started here (workflow_dispatch added at launch), once per commit.
 * Returns true when a run was requested.
 */
export async function ensureBranchCi(gh, integ, snap, memo = {}) {
  if (!snap.branch || !snap.ci || snap.ci.status !== 'none' || !snap.ci.headSha) return false;
  memo.dispatched ??= new Set();
  if (memo.dispatched.has(snap.ci.headSha)) return false;
  memo.dispatched.add(snap.ci.headSha);
  await gh.post(`/repos/${integ.owner}/${integ.repoName}/actions/workflows/ci.yml/dispatches`, { ref: snap.branch });
  return true;
}
