// Fake Discourse forum and fake Gladys store catalog.

import { startFake } from './server.js';

export async function startFakeForum({ topics = [], apiKey = 'forum-key-123' } = {}) {
  const fake = await startFake(({ method, path, query, headers, body }) => {
    if (method === 'GET' && path === '/search.json') {
      const q = (query.get('q') ?? '').toLowerCase();
      const words = q.replace(/in:title/, '').split(/\s+/).filter(Boolean);
      const hits = fake.topics.filter((t) => words.some((w) => t.title.toLowerCase().includes(w)));
      return { body: { topics: hits } };
    }
    if (method === 'POST' && path === '/posts.json') {
      if (headers['api-key'] !== apiKey) return { status: 403, body: { errors: ['Clé API invalide'] } };
      const id = 1000 + fake.topics.length;
      const slug = body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      fake.topics.push({ id, title: body.title, slug, raw: body.raw, category: body.category, user: headers['api-username'] });
      return { body: { topic_id: id, topic_slug: slug } };
    }
    return undefined;
  });
  fake.topics = [...topics];
  return fake;
}

export async function startFakeStore({ integrations = [], rejected = [] } = {}) {
  const fake = await startFake(({ path }) => {
    if (path === '/index-lite.json') return { body: { index_format: 1, integrations: fake.integrations } };
    if (path === '/rejected.json') return { body: fake.rejected };
    return undefined;
  });
  fake.integrations = integrations;
  fake.rejected = rejected;
  return fake;
}

/** Store entry shaped like index-lite.json. */
export function storeEntry(owner, repo, name, keywords = []) {
  return {
    store_slug: `${owner}/${repo}`,
    repo_url: `https://github.com/${owner}/${repo}`,
    manifest: { name, keywords },
  };
}
