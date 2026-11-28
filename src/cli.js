// -----------------------------------------------------------------------------
// Emergency commands, run with the app STOPPED (both write state.json):
//   docker compose stop
//   docker compose run --rm external-integration-creator node src/cli.js users
//   docker compose run --rm external-integration-creator node src/cli.js reset <name>
//   docker compose start
// "reset": new temporary password, 2nd factors removed, account re-enabled,
// sessions closed. The person then sets a new password and a 2nd factor.
// -----------------------------------------------------------------------------

import { hashPassword, randomCode } from './auth/crypto.js';
import { Db } from './db.js';

const [command, name] = process.argv.slice(2);
const dataDir = process.env.DATA_DIR || '/data';

function usage() {
  process.stdout.write(
    'Commandes (appli arrêtée) :\n' +
      '  node src/cli.js users          liste les comptes\n' +
      '  node src/cli.js reset <nom>    mot de passe temporaire, double authentification retirée\n',
  );
  process.exit(command ? 1 : 0);
}

const db = await new Db(dataDir).load();
const users = db.read().users ?? [];

if (command === 'users') {
  if (!users.length) process.stdout.write('Aucun compte.\n');
  for (const u of users) {
    const mfa = [u.totp?.enabledAt ? 'appli' : null, u.passkeys?.length ? `${u.passkeys.length} clé(s)` : null].filter(Boolean);
    process.stdout.write(
      `${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.disabled ? 'désactivé ' : ''}2FA: ${mfa.join(', ') || 'aucune'}\n`,
    );
  }
} else if (command === 'reset' && name) {
  const user = users.find((u) => u.username.toLowerCase() === name.toLowerCase());
  if (!user) {
    process.stderr.write(`Compte « ${name} » introuvable.\n`);
    process.exit(1);
  }
  const password = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
  const passwordHash = await hashPassword(password);
  await db.update((s) => {
    const u = s.users.find((x) => x.id === user.id);
    Object.assign(u, { passwordHash, mustChangePassword: true, disabled: false, totp: null, passkeys: [], recovery: [] });
    s.sessions = (s.sessions ?? []).filter((x) => x.userId !== user.id);
    s.audit = [
      { at: new Date().toISOString(), action: 'Compte réinitialisé (ligne de commande)', actor: 'cli', target: u.username, ip: null, ok: true },
      ...(s.audit ?? []),
    ].slice(0, 500);
  });
  process.stdout.write(
    `Compte « ${user.username} » réinitialisé.\nMot de passe temporaire : ${password}\n` +
      'À changer à la première connexion. Relancez l’appli : docker compose start\n',
  );
} else {
  usage();
}
