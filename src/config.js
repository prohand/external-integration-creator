// -----------------------------------------------------------------------------
// Runtime configuration, read once from the environment (and `.env`).
// Every external URL is configurable so the tests can point at fake servers.
// -----------------------------------------------------------------------------

import { MIN_PASSWORD_LENGTH } from './auth/crypto.js';

const DEFAULTS = {
  PORT: '3000',
  HOST: '0.0.0.0',
  BASE_PATH: '',
  APP_USER: 'admin',
  APP_PASSWORD: '',
  DATA_DIR: '/data',
  CACHE_TTL_MINUTES: '15',
  TRUST_PROXY: 'false',
  NO_PASSWORD: 'false',
  ALLOWED_HOSTS: '',
  DRY_RUN: 'false',
  LOG_LEVEL: 'info',
  TRACKER_BASE_URL: 'https://william-de71.github.io/gladys-integrations-tracker',
  STORE_BASE_URL: 'https://integration-store-storage.gladysassistant.com',
  FORUM_URL: 'https://community.gladysassistant.com',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_WEB_URL: 'https://github.com',
  GITHUB_TOKEN: '',
  HTTP_TIMEOUT_SECONDS: '20',
  TEMPLATE_REPO: 'GladysAssistant/integration-template-js',
  BRANCH_WAIT_SECONDS: '90',
  BRANCH_POLL_MS: '2000',
  DEV_POLL_SECONDS: '20',
  GHCR_URL: 'https://ghcr.io',
  PUBLISH_POLL_SECONDS: '10',
  STORE_CHECK_TIMEOUT_MINUTES: '15',
  RELEASE_TIMEOUT_MINUTES: '60',
  SESSION_DAYS: '7',
  SESSION_IDLE_HOURS: '12',
  PUBLIC_URL: '',
};

function bool(value) {
  return ['1', 'true', 'yes', 'on', 'oui'].includes(String(value).trim().toLowerCase());
}

function positiveNumber(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid value for ${name}: "${value}" (a positive number is expected)`);
  }
  return n;
}

function parseRepo(name, value) {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid value for ${name}: "${value}" (owner/repo expected)`);
  return { owner: match[1], repo: match[2] };
}

function trimSlash(url) {
  return String(url).trim().replace(/\/+$/, '');
}

/**
 * Normalizes BASE_PATH: "" or "/sub/path" (leading slash, no trailing slash).
 */
export function normalizeBasePath(value) {
  const parts = String(value ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!/^[A-Za-z0-9._~-]+$/.test(part) || part === '.' || part === '..') {
      throw new Error(`Invalid BASE_PATH segment: "${part}"`);
    }
  }
  return parts.length ? `/${parts.join('/')}` : '';
}

export { MIN_PASSWORD_LENGTH };

/** Raised for a configuration the app refuses to start with. */
export class ConfigError extends Error {}

function parseHosts(value) {
  return String(value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const get = (key) => (env[key] !== undefined && env[key] !== '' ? env[key] : DEFAULTS[key]);
  const config = Object.freeze({
    port: Number.parseInt(get('PORT'), 10),
    host: get('HOST'),
    basePath: normalizeBasePath(get('BASE_PATH')),
    appUser: get('APP_USER'),
    appPassword: env.APP_PASSWORD ?? '',
    dataDir: get('DATA_DIR'),
    cacheTtlMs: positiveNumber('CACHE_TTL_MINUTES', get('CACHE_TTL_MINUTES')) * 60_000,
    trustProxy: bool(get('TRUST_PROXY')),
    noPassword: bool(get('NO_PASSWORD')),
    allowedHosts: parseHosts(get('ALLOWED_HOSTS')),
    dryRun: bool(get('DRY_RUN')),
    logLevel: get('LOG_LEVEL'),
    trackerBaseUrl: trimSlash(get('TRACKER_BASE_URL')),
    storeBaseUrl: trimSlash(get('STORE_BASE_URL')),
    forumUrl: trimSlash(get('FORUM_URL')),
    githubApiUrl: trimSlash(get('GITHUB_API_URL')),
    githubWebUrl: trimSlash(get('GITHUB_WEB_URL')),
    githubToken: get('GITHUB_TOKEN'),
    httpTimeoutMs: positiveNumber('HTTP_TIMEOUT_SECONDS', get('HTTP_TIMEOUT_SECONDS')) * 1000,
    template: parseRepo('TEMPLATE_REPO', get('TEMPLATE_REPO')),
    branchWaitMs: positiveNumber('BRANCH_WAIT_SECONDS', get('BRANCH_WAIT_SECONDS')) * 1000,
    branchPollMs: positiveNumber('BRANCH_POLL_MS', get('BRANCH_POLL_MS')),
    devPollMs: positiveNumber('DEV_POLL_SECONDS', get('DEV_POLL_SECONDS')) * 1000,
    ghcrUrl: trimSlash(get('GHCR_URL')),
    publishPollMs: positiveNumber('PUBLISH_POLL_SECONDS', get('PUBLISH_POLL_SECONDS')) * 1000,
    storeCheckTimeoutMs: positiveNumber('STORE_CHECK_TIMEOUT_MINUTES', get('STORE_CHECK_TIMEOUT_MINUTES')) * 60_000,
    releaseTimeoutMs: positiveNumber('RELEASE_TIMEOUT_MINUTES', get('RELEASE_TIMEOUT_MINUTES')) * 60_000,
    sessionDays: positiveNumber('SESSION_DAYS', get('SESSION_DAYS')),
    sessionIdleHours: positiveNumber('SESSION_IDLE_HOURS', get('SESSION_IDLE_HOURS')),
    publicUrl: parsePublicUrl(get('PUBLIC_URL')),
  });
  checkAccess(config);
  return config;
}

function parsePublicUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`PUBLIC_URL invalide : "${text}" (ex. https://creator.mondomaine.fr)`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError('PUBLIC_URL doit commencer par https://');
  return url.origin;
}

/**
 * Access: user accounts (login page) by default. APP_PASSWORD, when set,
 * only creates the first administrator: it must then be long enough.
 * NO_PASSWORD=true turns the accounts off (an authenticating reverse proxy
 * such as Pangolin or Authelia stands in front).
 */
export function checkAccess(config) {
  if (config.appPassword && config.appPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(`APP_PASSWORD est trop court : ${MIN_PASSWORD_LENGTH} caractères minimum.`);
  }
}
