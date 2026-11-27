// -----------------------------------------------------------------------------
// Entry point: `node src/index.js`.
// -----------------------------------------------------------------------------

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { log, registerSecret, setLogLevel } from './log.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: the environment (docker compose env_file) is used as-is.
}

const config = loadConfig();
setLogLevel(config.logLevel);
registerSecret(config.githubToken);
registerSecret(config.appPassword);

const db = await new Db(config.dataDir).load();
for (const value of Object.values(db.read().secrets)) registerSecret(value);
const app = createApp({ config, db });
await app.runner.recover();

app.server.listen(config.port, config.host, () => {
  log.info(
    `Integration Creator à l'écoute sur ${config.host}:${config.port}${config.basePath || ''}/` +
      `${config.dryRun ? ' (mode simulation)' : ''}${config.appPassword ? ' (mot de passe actif)' : ''}`,
  );
});

// Read the tracker headers at startup: a format change shows up right away.
app.sources.tracker().then(
  ({ value }) =>
    log.info(`Tracker lu : ${value.ideas.length} idées, ${value.integrations.length} intégrations`),
  (err) => log.error(`Tracker illisible au démarrage : ${err.message}`),
);

function shutdown(signal) {
  log.info(`${signal} reçu, arrêt`);
  app.server.close(() => process.exit(0));
  app.server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
