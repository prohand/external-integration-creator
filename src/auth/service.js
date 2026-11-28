// -----------------------------------------------------------------------------
// Accounts: users, roles, sessions, second factors (TOTP, passkeys, recovery
// codes), login tickets, journal. Everything is stored in state.json (Db).
//
// Roles: admin (everything, users included) > member (uses the app) >
// viewer (reads only).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { log, registerSecret } from '../log.js';
import { ApiError } from '../web.js';
import {
  b64url,
  hashPassword,
  newRecoveryCodes,
  normalizeRecoveryCode,
  passwordProblem,
  randomCode,
  randomToken,
  safeEqual,
  sha256hex,
  verifyPassword,
} from './crypto.js';
import { createLimiter } from './limiter.js';
import { verifyTotp } from './totp.js';

export const ROLES = {
  admin: { rank: 3, label: 'Administrateur' },
  member: { rank: 2, label: 'Membre' },
  viewer: { rank: 1, label: 'Lecteur' },
};
export const roleRank = (role) => ROLES[role]?.rank ?? 0;

export const COOKIE = 'eic_session';
const TICKET_MS = 5 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const MAX_SESSIONS_PER_USER = 20;
const AUDIT_MAX = 500;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;

export const DEFAULT_SECURITY = { requireMfa: true };

const nowIso = () => new Date().toISOString();

export function hasMfa(user) {
  return Boolean(user.totp?.enabledAt) || (user.passkeys?.length ?? 0) > 0;
}

/** Bounded map of short-lived items (login tickets, WebAuthn challenges…). */
class Expiring {
  constructor(max = 1000) {
    this.items = new Map();
    this.max = max;
  }

  set(key, value, ttlMs) {
    const t = Date.now();
    for (const [k, v] of this.items) if (v.expires < t) this.items.delete(k);
    while (this.items.size >= this.max) this.items.delete(this.items.keys().next().value);
    this.items.set(key, { ...value, expires: t + ttlMs });
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expires < Date.now()) {
      this.items.delete(key);
      return null;
    }
    return item;
  }

  take(key) {
    const item = this.get(key);
    this.items.delete(key);
    return item;
  }

  delete(key) {
    this.items.delete(key);
  }

  deleteWhere(fn) {
    for (const [k, v] of this.items) if (fn(v)) this.items.delete(k);
  }
}

export class AuthService {
  constructor({ config, db }) {
    this.config = config;
    this.db = db;
    this.disabled = Boolean(config.noPassword);
    this.limiter = createLimiter();
    this.tickets = new Expiring(); // password OK, second factor awaited
    this.challenges = new Expiring(); // WebAuthn challenges
    this.totpPending = new Expiring(); // TOTP secret shown, not confirmed yet
    this.seen = new Map(); // session id -> last request time (ms)
    this.setupCode = null;
    this.sessionMs = config.sessionDays * 86_400_000;
    this.idleMs = config.sessionIdleHours * 3_600_000;
  }

  // --- state --------------------------------------------------------------------

  get state() {
    return this.db.state; // read-only use: writes go through db.update()
  }

  users() {
    return this.state.users ?? [];
  }

  security() {
    return { ...DEFAULT_SECURITY, ...this.state.security };
  }

  findUser(id) {
    return this.users().find((u) => u.id === id) ?? null;
  }

  findByName(username) {
    const name = String(username ?? '').trim().toLowerCase();
    return this.users().find((u) => u.username.toLowerCase() === name) ?? null;
  }

  mustFind(id) {
    const user = this.findUser(id);
    if (!user) throw new ApiError(404, 'Utilisateur introuvable.');
    return user;
  }

  /** What a user may do right now: full, or first change the password / add a 2nd factor. */
  access(user) {
    if (user.mustChangePassword) return 'password';
    if (this.security().requireMfa && !hasMfa(user)) return 'mfa';
    return 'full';
  }

  /** Writes into the user `id` of the saved state. */
  async updateUser(id, mutator) {
    return this.db.update((s) => {
      const user = (s.users ?? []).find((u) => u.id === id);
      if (!user) throw new ApiError(404, 'Utilisateur introuvable.');
      return mutator(user, s);
    });
  }

  audit(action, { actor, target, ip, ok = true } = {}) {
    const entry = { at: nowIso(), action, actor: actor ?? null, target: target ?? null, ip: ip ?? null, ok };
    (ok ? log.info : log.warn)(`Compte : ${action}`, { actor: entry.actor, target: entry.target, ip: entry.ip });
    return this.db
      .update((s) => {
        s.audit = [entry, ...(s.audit ?? [])].slice(0, AUDIT_MAX);
      })
      .catch((err) => log.error(`Journal non écrit : ${err.message}`));
  }

  // --- first start --------------------------------------------------------------

  /**
   * No account yet: APP_PASSWORD creates the first administrator; otherwise a
   * one-time setup code is printed in the logs (docker compose logs).
   */
  async init() {
    if (this.disabled) return;
    for (const user of this.users()) {
      if (user.totp?.secret) registerSecret(user.totp.secret);
    }
    if (this.users().length) {
      if (this.config.appPassword) {
        log.info('APP_PASSWORD n’est plus utilisé (des comptes existent déjà) : vous pouvez le retirer de .env.');
      }
      return;
    }
    if (this.config.appPassword) {
      await this.createUser(
        { username: this.config.appUser, password: this.config.appPassword, role: 'admin' },
        { actor: 'APP_PASSWORD', temporary: false },
      );
      log.info(
        `Compte administrateur « ${this.config.appUser} » créé avec APP_PASSWORD. ` +
          'Connectez-vous, puis retirez APP_PASSWORD de .env.',
      );
      return;
    }
    this.setupCode = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`.toUpperCase();
    log.warn(
      `Première installation : ouvrez l’appli et entrez ce code pour créer le compte administrateur : ${this.setupCode}`,
    );
  }

  needsSetup() {
    return !this.disabled && this.users().length === 0;
  }

  async setup({ code, username, password }, client) {
    if (!this.needsSetup()) throw new ApiError(409, 'Le compte administrateur existe déjà.');
    const key = `ip:${client.ip}`;
    if (this.limiter.blocked(key)) throw new ApiError(429, 'Trop de tentatives, réessayez plus tard.');
    if (!this.setupCode || !safeEqual(String(code ?? '').trim().toUpperCase(), this.setupCode)) {
      this.limiter.fail(key);
      throw new ApiError(400, 'Code d’installation incorrect : il est affiché dans les journaux (docker compose logs).');
    }
    const user = await this.createUser({ username, password, role: 'admin' }, { actor: 'installation', temporary: false });
    this.setupCode = null;
    this.audit('Compte administrateur créé (installation)', { actor: user.username, ip: client.ip });
    return user;
  }

  // --- users ----------------------------------------------------------------------

  checkUsername(username, exceptId) {
    const name = String(username ?? '').trim();
    if (!USERNAME.test(name)) {
      throw new ApiError(400, 'Nom d’utilisateur : 2 à 40 caractères, lettres, chiffres, point, tiret ou soulignement.');
    }
    const other = this.findByName(name);
    if (other && other.id !== exceptId) throw new ApiError(409, `Le nom « ${name} » est déjà pris.`);
    return name;
  }

  checkPassword(password, username) {
    const problem = passwordProblem(password, username);
    if (problem) throw new ApiError(400, problem);
  }

  async createUser({ username, password, role }, { temporary = true } = {}) {
    const name = this.checkUsername(username);
    if (!ROLES[role]) throw new ApiError(400, 'Rôle inconnu.');
    this.checkPassword(password, name);
    const user = {
      id: randomToken(9),
      username: name,
      role,
      passwordHash: await hashPassword(password),
      handle: b64url(randomBytes(16)), // WebAuthn user id: random, never the name
      mustChangePassword: Boolean(temporary),
      disabled: false,
      totp: null,
      passkeys: [],
      recovery: [],
      createdAt: nowIso(),
      lastLoginAt: null,
    };
    await this.db.update((s) => {
      if ((s.users ?? []).some((u) => u.username.toLowerCase() === name.toLowerCase())) {
        throw new ApiError(409, `Le nom « ${name} » est déjà pris.`);
      }
      s.users = [...(s.users ?? []), user];
    });
    return user;
  }

  /** Never removes, disables or demotes the last active administrator. */
  checkLastAdmin(id, change) {
    const admins = this.users().filter((u) => u.role === 'admin' && !u.disabled);
    if (admins.length === 1 && admins[0].id === id) {
      throw new ApiError(409, `Impossible : c’est le dernier administrateur actif (${change}).`);
    }
  }

  async updateRoleOrStatus(id, { role, disabled }, actor) {
    const user = this.mustFind(id);
    if (role !== undefined && !ROLES[role]) throw new ApiError(400, 'Rôle inconnu.');
    if ((role !== undefined && role !== 'admin' && user.role === 'admin') || disabled === true) {
      this.checkLastAdmin(id, role !== undefined && role !== 'admin' ? 'changement de rôle' : 'désactivation');
    }
    await this.updateUser(id, (u) => {
      if (role !== undefined) u.role = role;
      if (disabled !== undefined) u.disabled = Boolean(disabled);
    });
    if (disabled === true) await this.revokeSessions(id);
    if (role !== undefined && role !== user.role) {
      this.audit(`Rôle changé : ${ROLES[role].label}`, { actor: actor.username, target: user.username });
    }
    if (disabled !== undefined && Boolean(disabled) !== Boolean(user.disabled)) {
      this.audit(disabled ? 'Compte désactivé' : 'Compte réactivé', { actor: actor.username, target: user.username });
    }
  }

  async deleteUser(id, actor) {
    const user = this.mustFind(id);
    if (id === actor.id) throw new ApiError(409, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (user.role === 'admin') this.checkLastAdmin(id, 'suppression');
    await this.db.update((s) => {
      s.users = s.users.filter((u) => u.id !== id);
      s.sessions = (s.sessions ?? []).filter((x) => x.userId !== id);
    });
    this.audit('Compte supprimé', { actor: actor.username, target: user.username });
  }

  async setPassword(id, password, { temporary, keepSession } = {}) {
    const user = this.mustFind(id);
    this.checkPassword(password, user.username);
    const passwordHash = await hashPassword(password);
    await this.updateUser(id, (u) => {
      u.passwordHash = passwordHash;
      u.mustChangePassword = Boolean(temporary);
    });
    await this.revokeSessions(id, { except: keepSession });
  }

  async resetMfa(id, actor) {
    const user = this.mustFind(id);
    await this.updateUser(id, (u) => {
      u.totp = null;
      u.passkeys = [];
      u.recovery = [];
    });
    await this.revokeSessions(id);
    this.audit('Double authentification réinitialisée', { actor: actor.username, target: user.username });
  }

  async requirePassword(user, password, client) {
    const key = `user:${user.id}`;
    if (this.limiter.blocked(key, { useGlobal: false })) {
      throw new ApiError(429, `Trop d’essais : réessayez dans ${this.limiter.waitMinutes(key)} min.`);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      this.limiter.fail(key, { useGlobal: false });
      this.audit('Mot de passe incorrect (confirmation)', { actor: user.username, ip: client?.ip, ok: false });
      throw new ApiError(403, 'Mot de passe actuel incorrect.');
    }
  }

  // --- recovery codes ---------------------------------------------------------------

  /** New recovery codes (shown once). Stored as hashes only. */
  async newRecovery(id) {
    const codes = newRecoveryCodes();
    await this.updateUser(id, (u) => {
      u.recovery = codes.map((c) => sha256hex(c));
      u.recoveryCreatedAt = nowIso();
    });
    return codes;
  }

  /** First second factor added: the user gets recovery codes at the same time. */
  async recoveryIfFirst(user) {
    return user.recovery?.length ? null : this.newRecovery(user.id);
  }

  // --- login --------------------------------------------------------------------------

  blockedMessage(key) {
    return `Trop de tentatives : réessayez dans ${this.limiter.waitMinutes(key)} min.`;
  }

  /**
   * Step 1: user name + password. Returns { user } when no second factor is
   * set, or { ticket, methods } when one is awaited.
   */
  async passwordLogin({ username, password }, client) {
    const ipKey = `ip:${client.ip}`;
    if (this.limiter.blocked(ipKey)) throw new ApiError(429, this.blockedMessage(ipKey));
    const user = this.findByName(username);
    const userKey = user ? `user:${user.id}` : null;
    if (userKey && this.limiter.blocked(userKey, { perKey: 20, useGlobal: false })) {
      throw new ApiError(429, 'Compte bloqué temporairement après trop d’échecs : réessayez plus tard.');
    }
    const ok = await verifyPassword(password, user?.passwordHash);
    if (!ok || !user || user.disabled) {
      this.limiter.fail(ipKey);
      if (userKey) this.limiter.fail(userKey, { useGlobal: false });
      this.audit('Échec de connexion', {
        actor: String(username ?? '').slice(0, 40) || null,
        ip: client.ip,
        ok: false,
      });
      // Same message whatever went wrong: no hint about which accounts exist.
      throw new ApiError(401, 'Nom d’utilisateur ou mot de passe incorrect.');
    }
    this.limiter.success(ipKey);
    if (!hasMfa(user)) return { user, method: 'mot de passe' };
    const ticket = randomToken();
    this.tickets.set(sha256hex(ticket), { userId: user.id, attempts: 0 }, TICKET_MS);
    const methods = [];
    if (user.totp?.enabledAt) methods.push('totp');
    if (user.passkeys?.length) methods.push('passkey');
    if (user.recovery?.length) methods.push('recovery');
    return { ticket, methods };
  }

  ticketUser(ticket) {
    const item = this.tickets.get(sha256hex(String(ticket ?? '')));
    if (!item) throw new ApiError(401, 'Connexion expirée : entrez à nouveau votre mot de passe.');
    const user = this.findUser(item.userId);
    if (!user || user.disabled) throw new ApiError(401, 'Connexion expirée : entrez à nouveau votre mot de passe.');
    return { item, user };
  }

  ticketFailed(ticket, item, user, client, what) {
    item.attempts += 1;
    this.limiter.fail(`ip:${client.ip}`);
    this.limiter.fail(`user:${user.id}`, { useGlobal: false });
    this.audit(`Échec de connexion (${what})`, { actor: user.username, ip: client.ip, ok: false });
    if (item.attempts >= 5) {
      this.tickets.delete(sha256hex(ticket));
      throw new ApiError(401, 'Trop d’essais : entrez à nouveau votre mot de passe.');
    }
  }

  async totpLogin({ ticket, code }, client) {
    const { item, user } = this.ticketUser(ticket);
    if (!user.totp?.enabledAt) throw new ApiError(400, 'Pas d’application d’authentification sur ce compte.');
    const counter = verifyTotp(user.totp.secret, code, { lastCounter: user.totp.lastCounter ?? -1 });
    if (counter === null) {
      this.ticketFailed(ticket, item, user, client, 'code TOTP');
      throw new ApiError(401, 'Code incorrect ou déjà utilisé.');
    }
    await this.updateUser(user.id, (u) => {
      u.totp.lastCounter = counter;
    });
    this.tickets.delete(sha256hex(ticket));
    return { user, method: 'mot de passe + application' };
  }

  async recoveryLogin({ ticket, code }, client) {
    const { item, user } = this.ticketUser(ticket);
    const clean = normalizeRecoveryCode(code);
    const hash = clean ? sha256hex(clean) : null;
    const found = hash && (user.recovery ?? []).find((h) => safeEqual(h, hash));
    if (!found) {
      this.ticketFailed(ticket, item, user, client, 'code de secours');
      throw new ApiError(401, 'Code de secours incorrect ou déjà utilisé.');
    }
    let left = 0;
    await this.updateUser(user.id, (u) => {
      u.recovery = u.recovery.filter((h) => h !== found);
      left = u.recovery.length;
    });
    this.tickets.delete(sha256hex(ticket));
    this.audit(`Code de secours utilisé (${left} restants)`, { actor: user.username, ip: client.ip });
    return { user, method: 'mot de passe + code de secours', recoveryLeft: left };
  }

  // --- sessions -----------------------------------------------------------------------

  cookieHeader(value, maxAgeSeconds, client) {
    const path = `${this.config.basePath}/`;
    const secure = client.proto === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
  }

  clearCookie(client) {
    return this.cookieHeader('', 0, client);
  }

  /** Opens a session; returns the Set-Cookie header value. */
  async startSession(user, { method }, client, req) {
    const token = randomToken(32);
    const t = Date.now();
    const session = {
      id: sha256hex(token),
      sid: randomToken(9), // public id, shown in the session list
      userId: user.id,
      createdAt: new Date(t).toISOString(),
      lastSeenAt: new Date(t).toISOString(),
      expiresAt: new Date(t + this.sessionMs).toISOString(),
      ip: client.ip,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
      method,
    };
    await this.db.update((s) => {
      const alive = (s.sessions ?? []).filter((x) => this.alive(x, t));
      const mine = alive.filter((x) => x.userId === user.id);
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER + 1)).map((x) => x.id));
      s.sessions = [...alive.filter((x) => !drop.has(x.id)), session];
      const u = s.users.find((x) => x.id === user.id);
      if (u) u.lastLoginAt = session.createdAt;
    });
    this.seen.set(session.id, t);
    this.limiter.success(`user:${user.id}`);
    this.audit(`Connexion réussie (${method})`, { actor: user.username, ip: client.ip });
    return this.cookieHeader(token, Math.floor(this.sessionMs / 1000), client);
  }

  lastSeen(session) {
    return this.seen.get(session.id) ?? Date.parse(session.lastSeenAt);
  }

  alive(session, t = Date.now()) {
    return Date.parse(session.expiresAt) > t && t - this.lastSeen(session) < this.idleMs;
  }

  /** The user behind the request's cookie, or null. */
  authenticate(req) {
    if (this.disabled) {
      return { user: { id: 'proxy', username: 'reverse proxy', role: 'admin' }, access: 'full', virtual: true };
    }
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token || token.length > 100) return null;
    const id = sha256hex(token);
    const session = (this.state.sessions ?? []).find((s) => s.id === id);
    const t = Date.now();
    if (!session || !this.alive(session, t)) return null;
    const user = this.findUser(session.userId);
    if (!user || user.disabled) return null;
    this.seen.set(id, t);
    // Saved now and then, so that the idle timeout survives a restart.
    if (t - Date.parse(session.lastSeenAt) > 10 * 60_000) {
      this.db
        .update((s) => {
          const x = (s.sessions ?? []).find((y) => y.id === id);
          if (x) x.lastSeenAt = new Date(t).toISOString();
        })
        .catch(() => {});
    }
    return { user, session, access: this.access(user) };
  }

  async endSession(sessionId) {
    this.seen.delete(sessionId);
    await this.db.update((s) => {
      s.sessions = (s.sessions ?? []).filter((x) => x.id !== sessionId);
    });
  }

  async revokeSessions(userId, { except } = {}) {
    await this.db.update((s) => {
      s.sessions = (s.sessions ?? []).filter((x) => x.userId !== userId || x.id === except);
    });
    this.tickets.deleteWhere((item) => item.userId === userId);
  }

  sessionsOf(userId, currentId) {
    const t = Date.now();
    return (this.state.sessions ?? [])
      .filter((s) => s.userId === userId && this.alive(s, t))
      .map((s) => ({
        id: s.sid,
        current: s.id === currentId,
        createdAt: s.createdAt,
        lastSeenAt: new Date(this.lastSeen(s)).toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
        method: s.method,
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async revokeSession(userId, sid) {
    let found = false;
    await this.db.update((s) => {
      const before = (s.sessions ?? []).length;
      s.sessions = (s.sessions ?? []).filter((x) => !(x.userId === userId && x.sid === sid));
      found = s.sessions.length !== before;
    });
    if (!found) throw new ApiError(404, 'Session introuvable.');
  }

  // --- views ----------------------------------------------------------------------------

  publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      roleLabel: ROLES[user.role]?.label ?? user.role,
      disabled: Boolean(user.disabled),
      mustChangePassword: Boolean(user.mustChangePassword),
      totp: Boolean(user.totp?.enabledAt),
      passkeys: user.passkeys?.length ?? 0,
      recoveryLeft: user.recovery?.length ?? 0,
      mfa: hasMfa(user),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      sessions: this.sessionsOf(user.id).length,
    };
  }
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
