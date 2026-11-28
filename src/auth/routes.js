// -----------------------------------------------------------------------------
// Account routes:
//   /api/auth/*     login page (public): password, TOTP, passkey, recovery code
//   /api/account/*  my account: password, authenticator app, passkeys, sessions
//   /api/users/*    user management (administrators)
// -----------------------------------------------------------------------------

import { registerSecret } from '../log.js';
import { ApiError } from '../web.js';
import { randomCode, randomToken, sha256hex } from './crypto.js';
import { ROLES, hasMfa } from './service.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import {
  WebAuthnError,
  authenticationOptions,
  challengeOf,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.js';

const ISSUER = 'Gladys Integration Creator';
const FRESH_MS = 10 * 60_000; // "recent login": no password asked again
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

export function registerAuthRoutes(router, { auth, config, hasSharedClaudeToken = () => false }) {
  const PUBLIC = { public: true };
  const SELF = { role: 'viewer', restricted: true };
  const ADMIN = { role: 'admin' };

  const notDisabled = () => {
    if (auth.disabled) {
      throw new ApiError(409, 'Comptes désactivés : NO_PASSWORD=true (le reverse proxy authentifie).');
    }
  };

  /** WebAuthn needs a domain name in HTTPS (or localhost), never an IP address. */
  function relyingParty(client) {
    let url;
    try {
      url = new URL(config.publicUrl || `${client.proto}://${client.host}`);
    } catch {
      throw new ApiError(400, 'Adresse de l’appli illisible.');
    }
    if (IP_HOST.test(url.host.replace(/:\d+$/, '')) || url.hostname.includes(':')) {
      throw new ApiError(
        400,
        'Les clés d’accès demandent un nom de domaine (ou localhost), pas une adresse IP : passez par votre reverse proxy.',
      );
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      throw new ApiError(400, 'Les clés d’accès demandent HTTPS (ou localhost).');
    }
    return { origin: url.origin, rpId: url.hostname };
  }

  function webauthnCall(fn) {
    try {
      return fn();
    } catch (err) {
      if (err instanceof WebAuthnError) throw new ApiError(400, err.message);
      throw err;
    }
  }

  /** Sensitive changes: password asked again, unless the login is recent. */
  async function confirmIdentity({ auth: a, body, client }) {
    if (Date.now() - Date.parse(a.session.createdAt) < FRESH_MS) return;
    if (!body?.password) {
      throw new ApiError(403, 'Confirmez avec votre mot de passe.', { needPassword: true });
    }
    await auth.requirePassword(a.user, body.password, client);
  }

  const me = (a) =>
    a
      ? {
          user: a.virtual ? { username: a.user.username, role: 'admin', roleLabel: ROLES.admin.label } : auth.publicUser(a.user),
          access: a.access,
        }
      : { user: null, access: null };

  async function loggedIn({ req, res, client }, result) {
    const cookie = await auth.startSession(result.user, { method: result.method }, client, req);
    res.setHeader('set-cookie', cookie);
    const user = auth.findUser(result.user.id);
    return { ok: true, ...me({ user, access: auth.access(user) }), recoveryLeft: result.recoveryLeft };
  }

  // --- login page ---------------------------------------------------------------

  router.get(
    '/api/auth/me',
    ({ auth: a }) => ({
      authDisabled: auth.disabled,
      needsSetup: auth.needsSetup(),
      requireMfa: auth.security().requireMfa,
      ...me(a),
    }),
    PUBLIC,
  );

  router.post(
    '/api/auth/setup',
    async (ctx) => {
      notDisabled();
      const user = await auth.setup(ctx.body ?? {}, ctx.client);
      return loggedIn(ctx, { user, method: 'installation' });
    },
    PUBLIC,
  );

  router.post(
    '/api/auth/login',
    async (ctx) => {
      notDisabled();
      const result = await auth.passwordLogin(ctx.body ?? {}, ctx.client);
      if (result.ticket) return { mfa: { ticket: result.ticket, methods: result.methods } };
      return loggedIn(ctx, result);
    },
    PUBLIC,
  );

  router.post(
    '/api/auth/login/totp',
    async (ctx) => {
      notDisabled();
      return loggedIn(ctx, await auth.totpLogin(ctx.body ?? {}, ctx.client));
    },
    PUBLIC,
  );

  router.post(
    '/api/auth/login/recovery',
    async (ctx) => {
      notDisabled();
      return loggedIn(ctx, await auth.recoveryLogin(ctx.body ?? {}, ctx.client));
    },
    PUBLIC,
  );

  // Passkey: alone (no user name typed: the browser offers the saved
  // passkeys), or as second factor after the password (ticket).
  router.post(
    '/api/auth/passkey/options',
    ({ body, client }) => {
      notDisabled();
      const { origin, rpId } = relyingParty(client);
      let allow = [];
      let ticket = null;
      if (body?.ticket) {
        const { user } = auth.ticketUser(body.ticket);
        ticket = body.ticket;
        allow = user.passkeys.map((p) => p.id);
      }
      const challenge = randomToken();
      auth.challenges.set(challenge, { purpose: 'login', ticket, origin, rpId }, 5 * 60_000);
      return authenticationOptions({ rpId, challenge, allow });
    },
    PUBLIC,
  );

  router.post(
    '/api/auth/passkey/login',
    async (ctx) => {
      notDisabled();
      const { body, client } = ctx;
      const ipKey = `ip:${client.ip}`;
      if (auth.limiter.blocked(ipKey)) throw new ApiError(429, auth.blockedMessage(ipKey));
      const credential = body?.credential;
      const item = auth.challenges.take(challengeOf(credential));
      if (!item || item.purpose !== 'login') throw new ApiError(400, 'Défi expiré : recommencez.');
      const id = String(credential?.id ?? '');
      const user = auth.users().find((u) => (u.passkeys ?? []).some((p) => p.id === id));
      const refuse = (message, who) => {
        auth.limiter.fail(ipKey);
        auth.audit('Échec de connexion (clé d’accès)', { actor: who ?? null, ip: client.ip, ok: false });
        throw new ApiError(401, message);
      };
      if (!user || user.disabled) refuse('Clé d’accès inconnue sur cette appli.');
      if (item.ticket && auth.ticketUser(item.ticket).user.id !== user.id) {
        refuse('Cette clé d’accès est celle d’un autre compte.', user.username);
      }
      const passkey = user.passkeys.find((p) => p.id === id);
      let signCount;
      try {
        ({ signCount } = verifyAuthentication({
          credential,
          challenge: challengeOf(credential),
          origin: item.origin,
          rpId: item.rpId,
          passkey: { ...passkey, userHandle: user.handle },
        }));
      } catch (err) {
        if (err instanceof WebAuthnError) refuse(err.message, user.username);
        throw err;
      }
      await auth.updateUser(user.id, (u) => {
        const p = u.passkeys.find((x) => x.id === id);
        p.signCount = signCount;
        p.lastUsedAt = new Date().toISOString();
      });
      if (item.ticket) auth.tickets.delete(sha256hex(item.ticket));
      return loggedIn(ctx, { user, method: item.ticket ? 'mot de passe + clé d’accès' : 'clé d’accès' });
    },
    PUBLIC,
  );

  router.post(
    '/api/auth/logout',
    async ({ auth: a, res, client }) => {
      if (a?.session) await auth.endSession(a.session.id);
      res.setHeader('set-cookie', auth.clearCookie(client));
      return { ok: true };
    },
    PUBLIC,
  );

  // --- my account ---------------------------------------------------------------

  router.get(
    '/api/account',
    ({ auth: a }) => {
      notDisabled();
      const user = a.user;
      return {
        ...auth.publicUser(user),
        access: a.access,
        requireMfa: auth.security().requireMfa,
        sharedClaudeToken: hasSharedClaudeToken(),
        totpSince: user.totp?.enabledAt ?? null,
        recoveryCreatedAt: user.recoveryCreatedAt ?? null,
        passkeyList: (user.passkeys ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt,
          backedUp: Boolean(p.backedUp),
        })),
        sessionList: auth.sessionsOf(user.id, a.session.id),
      };
    },
    SELF,
  );

  router.post(
    '/api/account/password',
    async ({ auth: a, body, client }) => {
      notDisabled();
      await auth.requirePassword(a.user, body?.current, client);
      if (body?.current === body?.password) throw new ApiError(400, 'Le nouveau mot de passe doit être différent.');
      await auth.setPassword(a.user.id, body?.password, { keepSession: a.session.id });
      auth.audit('Mot de passe changé', { actor: a.user.username, ip: client.ip });
      return { ok: true, access: auth.access(auth.findUser(a.user.id)) };
    },
    SELF,
  );

  // Authenticator app: 1) secret + QR code, 2) a first code confirms it.
  router.post(
    '/api/account/totp/setup',
    async (ctx) => {
      notDisabled();
      const user = ctx.auth.user;
      if (user.totp?.enabledAt) throw new ApiError(409, 'L’application d’authentification est déjà activée.');
      await confirmIdentity(ctx);
      const secret = newTotpSecret();
      auth.totpPending.set(user.id, { secret }, 10 * 60_000);
      return { secret, uri: otpauthUri({ secret, account: user.username, issuer: ISSUER }) };
    },
    SELF,
  );

  router.post(
    '/api/account/totp/enable',
    async ({ auth: a, body, client }) => {
      notDisabled();
      const pending = auth.totpPending.get(a.user.id);
      if (!pending) throw new ApiError(409, 'Délai dépassé : recommencez l’activation.');
      const counter = verifyTotp(pending.secret, body?.code);
      if (counter === null) throw new ApiError(400, 'Code incorrect : vérifiez l’heure du téléphone et réessayez.');
      await auth.updateUser(a.user.id, (u) => {
        u.totp = { secret: pending.secret, enabledAt: new Date().toISOString(), lastCounter: counter };
      });
      registerSecret(pending.secret);
      auth.totpPending.delete(a.user.id);
      auth.audit('Application d’authentification activée', { actor: a.user.username, ip: client.ip });
      return { ok: true, recoveryCodes: await auth.recoveryIfFirst(a.user) };
    },
    SELF,
  );

  router.post(
    '/api/account/totp/disable',
    async (ctx) => {
      notDisabled();
      const { auth: a, client } = ctx;
      if (!a.user.totp?.enabledAt) throw new ApiError(409, 'L’application d’authentification n’est pas activée.');
      await confirmIdentity(ctx);
      if (auth.security().requireMfa && !a.user.passkeys?.length) {
        throw new ApiError(409, 'La double authentification est obligatoire : ajoutez d’abord une clé d’accès.');
      }
      await auth.updateUser(a.user.id, (u) => {
        u.totp = null;
        if (!u.passkeys?.length) u.recovery = [];
      });
      auth.audit('Application d’authentification retirée', { actor: a.user.username, ip: client.ip });
      return { ok: true };
    },
    SELF,
  );

  router.post(
    '/api/account/passkeys/options',
    async (ctx) => {
      notDisabled();
      await confirmIdentity(ctx);
      const user = ctx.auth.user;
      const { origin, rpId } = relyingParty(ctx.client);
      const challenge = randomToken();
      auth.challenges.set(challenge, { purpose: 'register', userId: user.id, origin, rpId }, 5 * 60_000);
      return registrationOptions({
        rpId,
        rpName: ISSUER,
        user,
        challenge,
        exclude: (user.passkeys ?? []).map((p) => p.id),
      });
    },
    SELF,
  );

  router.post(
    '/api/account/passkeys',
    async ({ auth: a, body, client }) => {
      notDisabled();
      const credential = body?.credential;
      const item = auth.challenges.take(challengeOf(credential));
      if (!item || item.purpose !== 'register' || item.userId !== a.user.id) {
        throw new ApiError(400, 'Défi expiré : recommencez.');
      }
      const result = webauthnCall(() =>
        verifyRegistration({ credential, challenge: challengeOf(credential), origin: item.origin, rpId: item.rpId }),
      );
      if (auth.users().some((u) => (u.passkeys ?? []).some((p) => p.id === result.credentialId))) {
        throw new ApiError(409, 'Cette clé d’accès est déjà enregistrée.');
      }
      const count = a.user.passkeys?.length ?? 0;
      const name = String(body?.name ?? '').trim().slice(0, 60) || `Clé d’accès ${count + 1}`;
      await auth.updateUser(a.user.id, (u) => {
        if ((u.passkeys ?? []).length >= 20) throw new ApiError(409, '20 clés d’accès au plus par compte.');
        u.passkeys = [
          ...(u.passkeys ?? []),
          {
            id: result.credentialId,
            publicKey: result.publicKey,
            alg: result.alg,
            signCount: result.signCount,
            transports: result.transports,
            backedUp: result.backedUp,
            rpId: item.rpId,
            name,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
          },
        ];
      });
      auth.audit(`Clé d’accès ajoutée (${name})`, { actor: a.user.username, ip: client.ip });
      return { ok: true, recoveryCodes: await auth.recoveryIfFirst(a.user) };
    },
    SELF,
  );

  router.put(
    '/api/account/passkeys/:id',
    async ({ auth: a, params, body }) => {
      notDisabled();
      const name = String(body?.name ?? '').trim().slice(0, 60);
      if (!name) throw new ApiError(400, 'Nom vide.');
      await auth.updateUser(a.user.id, (u) => {
        const p = (u.passkeys ?? []).find((x) => x.id === params.id);
        if (!p) throw new ApiError(404, 'Clé d’accès introuvable.');
        p.name = name;
      });
      return { ok: true };
    },
    SELF,
  );

  router.post(
    '/api/account/passkeys/:id/delete',
    async (ctx) => {
      notDisabled();
      const { auth: a, params, client } = ctx;
      const passkey = (a.user.passkeys ?? []).find((p) => p.id === params.id);
      if (!passkey) throw new ApiError(404, 'Clé d’accès introuvable.');
      await confirmIdentity(ctx);
      if (auth.security().requireMfa && !a.user.totp?.enabledAt && a.user.passkeys.length === 1) {
        throw new ApiError(
          409,
          'La double authentification est obligatoire : ajoutez d’abord une autre clé d’accès ou une application d’authentification.',
        );
      }
      await auth.updateUser(a.user.id, (u) => {
        u.passkeys = u.passkeys.filter((p) => p.id !== params.id);
        if (!hasMfa(u)) u.recovery = [];
      });
      auth.audit(`Clé d’accès supprimée (${passkey.name})`, { actor: a.user.username, ip: client.ip });
      return { ok: true };
    },
    SELF,
  );

  router.post(
    '/api/account/recovery',
    async (ctx) => {
      notDisabled();
      if (!hasMfa(ctx.auth.user)) throw new ApiError(409, 'Activez d’abord une double authentification.');
      await confirmIdentity(ctx);
      const codes = await auth.newRecovery(ctx.auth.user.id);
      auth.audit('Nouveaux codes de secours', { actor: ctx.auth.user.username, ip: ctx.client.ip });
      return { recoveryCodes: codes };
    },
    SELF,
  );

  // Personal Claude token (claude setup-token): the launches of this person
  // use their own subscription seat (Pro, Max, Team, Enterprise).
  router.put(
    '/api/account/claude-token',
    async ({ auth: a, body, client }) => {
      notDisabled();
      const value = body?.token;
      let token = null;
      if (value !== null && value !== '') {
        token = String(value ?? '').trim();
        if (token.length < 20 || token.length > 500 || /\s/.test(token)) {
          throw new ApiError(400, 'Jeton Claude invalide : copiez la ligne entière affichée par « claude setup-token ».');
        }
      }
      await auth.updateUser(a.user.id, (u) => {
        if (token) u.claudeToken = token;
        else delete u.claudeToken;
      });
      if (token) registerSecret(token);
      auth.audit(token ? 'Jeton Claude personnel enregistré' : 'Jeton Claude personnel effacé', {
        actor: a.user.username,
        ip: client.ip,
      });
      return { claudeTokenSet: Boolean(token), sharedClaudeToken: hasSharedClaudeToken() };
    },
    { role: 'member' },
  );

  router.post(
    '/api/account/sessions/:sid/revoke',
    async ({ auth: a, params }) => {
      notDisabled();
      await auth.revokeSession(a.user.id, params.sid);
      return { ok: true };
    },
    SELF,
  );

  router.post(
    '/api/account/sessions/revoke-others',
    async ({ auth: a, client }) => {
      notDisabled();
      await auth.revokeSessions(a.user.id, { except: a.session.id });
      auth.audit('Autres sessions fermées', { actor: a.user.username, ip: client.ip });
      return { ok: true };
    },
    SELF,
  );

  // --- user management (administrators) -------------------------------------------

  router.get(
    '/api/users',
    () => {
      notDisabled();
      return {
        users: auth
          .users()
          .map((u) => auth.publicUser(u))
          .sort((a, b) => a.username.localeCompare(b.username, 'fr')),
        roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label })),
        security: auth.security(),
      };
    },
    ADMIN,
  );

  router.get(
    '/api/users/audit',
    () => {
      notDisabled();
      return { entries: (auth.state.audit ?? []).slice(0, 200) };
    },
    ADMIN,
  );

  const tempPassword = () => `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;

  router.post(
    '/api/users',
    async ({ auth: a, body, client }) => {
      notDisabled();
      const generated = !body?.password;
      const password = generated ? tempPassword() : String(body.password);
      const user = await auth.createUser({ username: body?.username, password, role: body?.role ?? 'member' });
      auth.audit(`Compte créé (${ROLES[user.role].label})`, { actor: a.user.username, target: user.username, ip: client.ip });
      return { user: auth.publicUser(user), password: generated ? password : undefined };
    },
    ADMIN,
  );

  router.put(
    '/api/users/:id',
    async ({ auth: a, params, body }) => {
      notDisabled();
      await auth.updateRoleOrStatus(params.id, { role: body?.role, disabled: body?.disabled }, a.user);
      return auth.publicUser(auth.findUser(params.id));
    },
    ADMIN,
  );

  router.post(
    '/api/users/:id/password',
    async ({ auth: a, params, body, client }) => {
      notDisabled();
      const user = auth.mustFind(params.id);
      const generated = !body?.password;
      const password = generated ? tempPassword() : String(body.password);
      await auth.setPassword(user.id, password, { temporary: true });
      auth.audit('Mot de passe réinitialisé', { actor: a.user.username, target: user.username, ip: client.ip });
      return { password: generated ? password : undefined };
    },
    ADMIN,
  );

  router.post(
    '/api/users/:id/reset-mfa',
    async ({ auth: a, params }) => {
      notDisabled();
      await auth.resetMfa(params.id, a.user);
      return auth.publicUser(auth.findUser(params.id));
    },
    ADMIN,
  );

  router.post(
    '/api/users/:id/sessions/revoke',
    async ({ auth: a, params, client }) => {
      notDisabled();
      const user = auth.mustFind(params.id);
      await auth.revokeSessions(user.id, { except: user.id === a.user.id ? a.session.id : undefined });
      auth.audit('Sessions fermées', { actor: a.user.username, target: user.username, ip: client.ip });
      return { ok: true };
    },
    ADMIN,
  );

  router.delete(
    '/api/users/:id',
    async ({ auth: a, params }) => {
      notDisabled();
      await auth.deleteUser(params.id, a.user);
      return { ok: true };
    },
    ADMIN,
  );

  router.put(
    '/api/security',
    async ({ auth: a, body, client }) => {
      notDisabled();
      const requireMfa = body?.requireMfa === true;
      await auth.db.update((s) => {
        s.security = { ...s.security, requireMfa };
      });
      auth.audit(
        requireMfa ? 'Double authentification rendue obligatoire' : 'Double authentification rendue facultative',
        { actor: a.user.username, ip: client.ip },
      );
      return auth.security();
    },
    ADMIN,
  );
}
