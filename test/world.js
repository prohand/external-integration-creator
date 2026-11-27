// A complete fake world: tracker, GitHub, forum, store, and the app wired to them.

import { startFakeTracker } from './fakes/tracker.js';
import { startFakeGitHub } from './fakes/github.js';
import { startFakeForum, startFakeGhcr, startFakeStore } from './fakes/forum-store.js';
import { startApp } from './helpers.js';

export const HEADERS = { 'x-requested-with': 'integration-creator', 'content-type': 'application/json' };

export async function startWorld({ env = {}, github = {}, forum = {}, store = {} } = {}) {
  const fakes = {
    tracker: await startFakeTracker(),
    github: await startFakeGitHub(github),
    forum: await startFakeForum(forum),
    store: await startFakeStore(store),
    ghcr: await startFakeGhcr(),
  };
  const app = await startApp({
    TRACKER_BASE_URL: fakes.tracker.url,
    GITHUB_API_URL: fakes.github.url,
    FORUM_URL: fakes.forum.url,
    STORE_BASE_URL: fakes.store.url,
    GHCR_URL: fakes.ghcr.url,
    PUBLISH_POLL_SECONDS: '0.01',
    GITHUB_TOKEN: 'test-token',
    BRANCH_POLL_MS: '5',
    BRANCH_WAIT_SECONDS: '2',
    ...env,
  });
  const call = async (method, path, body) => {
    const res = await fetch(`${app.base}/api/${path}`, {
      method,
      headers: method === 'GET' ? {} : HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    app,
    ...fakes,
    call,
    /** Waits until the launch is no longer running. */
    async settle(id, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const { body } = await call('GET', `launches/${id}`);
        if (body.status !== 'running') return body;
        if (Date.now() > end) throw new Error(`launch still running: ${JSON.stringify(body.stepList.map((s) => [s.id, s.status]))}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    /** Connects the forum account like a user would (open, approve, paste). */
    async connectForum(options) {
      const { body } = await call('POST', 'forum/connect');
      return call('POST', 'forum/complete', { payload: fakes.forum.approve(body.url, options) });
    },
    /** Waits until the publication is no longer running. */
    async settlePublish(id, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const { body } = await call('GET', `launches/${id}`);
        if (body.publish?.status && body.publish.status !== 'running') return body;
        if (Date.now() > end) throw new Error(`publication still running: ${JSON.stringify(body.publish)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    writes() {
      // Requests that would change something on GitHub or the forum.
      return [...fakes.github.requests, ...fakes.forum.requests].filter((r) => r.method !== 'GET');
    },
    async close() {
      await app.close();
      await Promise.all(Object.values(fakes).map((f) => f.close()));
    },
  };
}

export const FORM = {
  ideaKey: 'idea:28',
  displayName: 'Oral-B',
  repoName: 'gladys-oral-b',
  description: {
    fr: 'Brosses à dents Oral-B : état, mode et durée du brossage.',
    en: 'Oral-B toothbrushes: status, mode and brushing time.',
    de: 'Oral-B Zahnbürsten: Status, Modus und Putzzeit.',
    es: 'Cepillos Oral-B: estado, modo y tiempo de cepillado.',
  },
  categories: ['services'],
  keywords: 'oral-b, toothbrush',
  spec: 'Lire l’état des brosses à dents en Bluetooth.',
  simulate: true,
};
