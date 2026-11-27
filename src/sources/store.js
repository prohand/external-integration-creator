// -----------------------------------------------------------------------------
// Gladys integration store: the public catalog (index-lite.json) and the list
// of integrations refused by the indexer (rejected.json).
// -----------------------------------------------------------------------------

import { fetchJson } from '../http.js';

/** Catalog entries reduced to what the name checks need. */
export async function fetchStoreIndex(config) {
  const data = await fetchJson(`${config.storeBaseUrl}/index-lite.json`, {
    timeoutMs: config.httpTimeoutMs,
  });
  if (!Array.isArray(data?.integrations)) {
    throw new Error('Format inattendu du catalogue du store (index-lite.json sans "integrations").');
  }
  return data.integrations.map((entry) => ({
    slug: entry.store_slug ?? '',
    repoUrl: entry.repo_url ?? '',
    name: entry.manifest?.name ?? '',
    keywords: Array.isArray(entry.manifest?.keywords) ? entry.manifest.keywords : [],
  }));
}

export async function fetchRejected(config) {
  return fetchJson(`${config.storeBaseUrl}/rejected.json`, { timeoutMs: config.httpTimeoutMs });
}
