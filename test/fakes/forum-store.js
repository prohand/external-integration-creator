// Fake Discourse forum and fake Gladys store catalog.

import { constants, publicEncrypt, randomBytes } from 'node:crypto';
import { startFake } from './server.js';

export async function startFakeForum({ topics = [], username = 'alice' } = {}) {
  const keys = new Map(); // user api key -> { username, clientId }
  const user = (headers) => keys.get(headers['user-api-key']);
  const fake = await startFake(({ method, path, query, headers, body }) => {
    if (method === 'GET' && path === '/search.json') {
      const q = (query.get('q') ?? '').toLowerCase();
      const words = q.replace(/in:title/, '').split(/\s+/).filter(Boolean);
      const hits = fake.topics.filter((t) => words.some((w) => t.title.toLowerCase().includes(w)));
      return { body: { topics: hits } };
    }
    if (method === 'GET' && path === '/categories.json') {
      return {
        body: {
          category_list: {
            categories: [
              { id: 32, name: 'Configuration' },
              { id: 33, name: 'Development', subcategory_list: [{ id: 99, name: 'Sub' }] },
            ],
          },
        },
      };
    }
    if (method === 'GET' && path === '/session/current.json') {
      const u = user(headers);
      return u ? { body: { current_user: { username: u.username } } } : { status: 404, body: {} };
    }
    if (method === 'POST' && path === '/user-api-key/revoke') {
      keys.delete(headers['user-api-key']);
      return { body: { success: 'OK' } };
    }
    if (method === 'POST' && path === '/posts.json') {
      const u = user(headers);
      if (!u) return { status: 403, body: { errors: ['Clé invalide'] } };
      const id = 1000 + fake.topics.length;
      const slug = body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      fake.topics.push({ id, title: body.title, slug, raw: body.raw, category: body.category, user: u.username });
      return { body: { topic_id: id, topic_slug: slug } };
    }
    return undefined;
  });
  fake.topics = [...topics];
  fake.keys = keys;

  /**
   * What the user does on the forum: approve the request of `url`.
   * Returns the code Discourse shows (Base64 with line breaks, like encode64).
   */
  fake.approve = (url, { padding } = {}) => {
    const params = new URL(url).searchParams;
    const key = randomBytes(16).toString('hex');
    keys.set(key, { username, clientId: params.get('client_id') });
    const json = JSON.stringify({ key, nonce: params.get('nonce'), push: false, api: 4 });
    const mode = padding ?? params.get('padding') ?? 'pkcs1';
    const encrypted =
      mode === 'oaep'
        ? publicEncrypt({ key: params.get('public_key'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(json))
        : publicEncrypt({ key: params.get('public_key'), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(json));
    return encrypted.toString('base64').replace(/(.{60})/g, '$1\n');
  };
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
