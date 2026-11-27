// -----------------------------------------------------------------------------
// Gladys community forum (Discourse).
// - Search for "Intégration externe - X" topics and for mentions in the
//   community topic where launches are announced in batches (public).
// - Each user connects their own account with a Discourse *User API Key*:
//   the app makes an RSA key pair, the user approves on the forum, the forum
//   shows an encrypted code, the user pastes it back here. No callback URL:
//   nothing has to be reachable from the Internet.
// -----------------------------------------------------------------------------

import { constants, createPrivateKey, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { USER_AGENT, fetchJson, httpRequest } from '../http.js';

export const TOPIC_PREFIX = 'Intégration externe - ';
export const APPLICATION_NAME = 'External Integration Creator';
export const SCOPES = 'read,write';
const TITLE = /^\s*int[ée]gration\s+externe\s*[-–—:]\s*(.+?)\s*$/i;

/** "Intégration externe - Oral-B" -> "Oral-B" (null for other titles). */
export function integrationNameFromTitle(title) {
  return TITLE.exec(String(title ?? ''))?.[1] ?? null;
}

export function topicTitle(displayName) {
  return `${TOPIC_PREFIX}${displayName}`;
}

/** Topics whose title is "Intégration externe - …" for a search term. */
export async function searchIntegrationTopics(config, term) {
  const q = `${TOPIC_PREFIX.replace(' - ', ' ')}${term} in:title`;
  const data = await fetchJson(`${config.forumUrl}/search.json?q=${encodeURIComponent(q)}`, {
    timeoutMs: config.httpTimeoutMs,
  });
  return (data?.topics ?? [])
    .map((t) => ({
      id: t.id,
      title: t.title ?? t.fancy_title ?? '',
      slug: t.slug ?? '',
      url: `${config.forumUrl}/t/${t.slug ?? 'topic'}/${t.id}`,
      name: integrationNameFromTitle(t.title ?? t.fancy_title),
    }))
    .filter((t) => t.name);
}

/**
 * Posts of the community topic (where launches are announced in batches)
 * that mention `term`. The first post (the list of candidates) is ignored.
 */
export async function searchTopicMentions(config, topicId, term) {
  const q = `${term} topic:${topicId}`;
  const data = await fetchJson(`${config.forumUrl}/search.json?q=${encodeURIComponent(q)}`, {
    timeoutMs: config.httpTimeoutMs,
  });
  return (data?.posts ?? [])
    .filter((p) => p.topic_id === Number(topicId) && p.post_number > 1)
    .map((p) => ({
      postNumber: p.post_number,
      username: p.username ?? '',
      createdAt: p.created_at ?? null,
      excerpt: String(p.blurb ?? '').slice(0, 160),
      url: `${config.forumUrl}/t/${topicId}/${p.post_number}`,
    }))
    .sort((x, y) => y.postNumber - x.postNumber);
}

// --- User API Key -------------------------------------------------------------------

/** Starts a connection: key pair + the forum URL the user must open. */
export function startUserApiKey(config) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pending = {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    nonce: randomBytes(16).toString('hex'),
    clientId: `eic-${randomBytes(12).toString('hex')}`,
    createdAt: new Date().toISOString(),
  };
  const params = new URLSearchParams({
    application_name: APPLICATION_NAME,
    client_id: pending.clientId,
    scopes: SCOPES,
    public_key: publicKey.export({ type: 'spki', format: 'pem' }),
    nonce: pending.nonce,
    padding: 'oaep',
  });
  return { pending, url: `${config.forumUrl}/user-api-key/new?${params}` };
}

const big = (b64url) => BigInt(`0x${Buffer.from(b64url, 'base64url').toString('hex') || '0'}`);

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** RSA PKCS#1 v1.5 decryption, for forums too old for OAEP (Node refuses it natively). */
function decryptPkcs1(privateKeyPem, data) {
  const jwk = createPrivateKey(privateKeyPem).export({ format: 'jwk' });
  const n = big(jwk.n);
  const size = Buffer.from(jwk.n, 'base64url').length;
  const m = modPow(BigInt(`0x${data.toString('hex')}`), big(jwk.d), n);
  const em = Buffer.from(m.toString(16).padStart(size * 2, '0'), 'hex');
  const sep = em.indexOf(0, 2);
  if (em[0] !== 0 || em[1] !== 2 || sep < 10) throw new Error('padding');
  return em.subarray(sep + 1);
}

/**
 * Decrypts the code shown by the forum and checks its nonce.
 * Returns the user API key.
 */
export function finishUserApiKey(pending, pasted) {
  let text = String(pasted ?? '').trim();
  if (/%[0-9A-Fa-f]{2}/.test(text)) text = decodeURIComponent(text);
  text = text.replace(/^.*payload=/s, '').replace(/[^A-Za-z0-9+/=_-]/g, '');
  const data = Buffer.from(text, 'base64');
  if (data.length < 64) throw new Error('Code incomplet : copiez tout le code affiché par le forum.');

  let plain;
  try {
    plain = privateDecrypt(
      { key: pending.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      data,
    );
  } catch {
    try {
      plain = decryptPkcs1(pending.privateKey, data);
    } catch {
      throw new Error('Code illisible : il ne correspond pas à la dernière demande. Recommencez la connexion.');
    }
  }
  let payload;
  try {
    payload = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('Code illisible.');
  }
  if (payload.nonce !== pending.nonce) throw new Error('Code refusé : il ne correspond pas à cette demande.');
  if (!payload.key) throw new Error('Le forum n’a pas donné de clé.');
  return payload.key;
}

function userHeaders(auth) {
  return {
    'user-api-key': auth.key,
    'user-api-client-id': auth.clientId,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
}

/** Username of the connected account. */
export async function currentUser(config, auth) {
  const response = await httpRequest(`${config.forumUrl}/session/current.json`, {
    timeoutMs: config.httpTimeoutMs,
    headers: userHeaders(auth),
  });
  if (!response.ok) throw new Error(`Le forum refuse la clé (réponse ${response.status}).`);
  const data = await response.json();
  return data?.current_user?.username ?? null;
}

export async function revokeUserApiKey(config, auth) {
  await httpRequest(`${config.forumUrl}/user-api-key/revoke`, {
    method: 'POST',
    timeoutMs: config.httpTimeoutMs,
    headers: userHeaders(auth),
  });
}

/** Replies in a topic with the user's key. Returns { postNumber, url }. */
export async function createPost(config, auth, { topicId, raw }) {
  const response = await httpRequest(`${config.forumUrl}/posts.json`, {
    method: 'POST',
    timeoutMs: config.httpTimeoutMs,
    headers: { ...userHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({ topic_id: Number(topicId), raw }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = Array.isArray(data?.errors) ? data.errors.join(', ') : `réponse ${response.status}`;
    throw new Error(`Le forum a refusé le message : ${reason}`);
  }
  return {
    postNumber: data.post_number,
    url: `${config.forumUrl}/t/${data.topic_slug ?? 'topic'}/${data.topic_id ?? topicId}/${data.post_number}`,
  };
}
