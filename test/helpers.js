// Test helpers: an app wired to fake servers, in a temporary data directory.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

export async function startApp(env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ic-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', NO_PASSWORD: 'true', ...env });
  const db = await new Db(dataDir).load();
  const app = createApp({ config, db });
  await app.auth.init();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app,
    config,
    db,
    base,
    async close() {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      await db.update(() => {}); // pending writes (journal) first
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
