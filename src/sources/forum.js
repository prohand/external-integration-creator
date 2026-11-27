// -----------------------------------------------------------------------------
// Gladys community forum (Discourse): search for "Intégration externe - X"
// topics, and topic creation with the user's API key.
// -----------------------------------------------------------------------------

import { USER_AGENT, fetchJson, httpRequest } from '../http.js';

export const TOPIC_PREFIX = 'Intégration externe - ';
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

/** Creates a topic. Returns { id, url }. */
export async function createTopic(config, { apiKey, username, categoryId, title, raw }) {
  const response = await httpRequest(`${config.forumUrl}/posts.json`, {
    method: 'POST',
    timeoutMs: config.httpTimeoutMs,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'api-key': apiKey,
      'api-username': username,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ title, raw, ...(categoryId ? { category: Number(categoryId) } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = Array.isArray(data?.errors) ? data.errors.join(', ') : `réponse ${response.status}`;
    throw new Error(`Le forum a refusé la création du sujet : ${reason}`);
  }
  return {
    id: data.topic_id,
    url: `${config.forumUrl}/t/${data.topic_slug ?? 'topic'}/${data.topic_id}`,
  };
}
