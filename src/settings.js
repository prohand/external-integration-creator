// -----------------------------------------------------------------------------
// User settings (stored in /data) and secrets. Secrets are write-only: the
// browser only ever learns whether each one is set.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { ApiError } from './web.js';
import { registerSecret } from './log.js';

export const REPO_SETTINGS_FILE = new URL('../config/repo-settings.json', import.meta.url);

export function loadRepoSettings(file = REPO_SETTINGS_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config/repo-settings.json illisible : ${err.message}`);
  }
}

// Secrets set from the settings form (the forum key comes from its own flow).
export const SECRET_NAMES = ['githubToken', 'claudeToken'];

// GitHub tokens: fine-grained (github_pat_…) or classic (ghp_…).
const GITHUB_TOKEN = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,250}$/;

export const DEFAULT_SETTINGS = {
  owner: '',
  forumUsername: '',
  claudeMaxTurns: null, // null = config/repo-settings.json (claude.max_turns)
  extraTopics: '',
};

export function publicSettings(state, config = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...state.settings };
  const secrets = Object.fromEntries(
    SECRET_NAMES.map((name) => [`${name}Set`, Boolean(state.secrets?.[name])]),
  );
  return {
    ...settings,
    ...secrets,
    forumConnected: Boolean(state.secrets?.forumUserApiKey),
    forumPending: Boolean(state.secrets?.forumPending),
    // Where the GitHub token comes from: the web page wins over .env.
    githubTokenSource: state.secrets?.githubToken ? 'web' : config.githubToken ? 'env' : null,
  };
}

const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;

export function parseTopics(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Validates a settings update. Secrets: string = set, null = clear, undefined = keep. */
export function validateSettingsUpdate(body) {
  const settings = {};
  const secrets = {};
  if (body.owner !== undefined) {
    const owner = String(body.owner).trim();
    if (owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
      throw new ApiError(400, 'Compte ou organisation GitHub invalide.');
    }
    settings.owner = owner;
  }
  if (body.claudeMaxTurns !== undefined) {
    if (body.claudeMaxTurns === null || body.claudeMaxTurns === '') settings.claudeMaxTurns = null;
    else {
      const n = Number(body.claudeMaxTurns);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new ApiError(400, 'Nombre de tours de Claude : de 1 à 200.');
      settings.claudeMaxTurns = n;
    }
  }
  if (body.extraTopics !== undefined) {
    const topics = parseTopics(body.extraTopics);
    const bad = topics.find((t) => !TOPIC.test(t));
    if (bad) throw new ApiError(400, `Topic invalide : « ${bad} » (minuscules, chiffres et tirets).`);
    settings.extraTopics = topics.join(', ');
  }
  for (const name of SECRET_NAMES) {
    const value = body[name];
    if (value === undefined) continue;
    if (value === null || value === '') secrets[name] = null;
    else {
      const secret = String(value).trim();
      if (secret.length < 8 || secret.length > 500 || /\s/.test(secret)) {
        throw new ApiError(400, 'Clé invalide.');
      }
      if (name === 'githubToken' && !GITHUB_TOKEN.test(secret)) {
        throw new ApiError(400, 'Jeton GitHub invalide : il commence par github_pat_ (fine-grained) ou ghp_ (classique).');
      }
      secrets[name] = secret;
    }
  }
  return { settings, secrets };
}

export async function saveSettings(db, body, config) {
  const { settings, secrets } = validateSettingsUpdate(body);
  await db.update((state) => {
    state.settings = { ...state.settings, ...settings };
    for (const [name, value] of Object.entries(secrets)) {
      if (value === null) delete state.secrets[name];
      else {
        state.secrets[name] = value;
        registerSecret(value);
      }
    }
  });
  return publicSettings(db.read(), config);
}
