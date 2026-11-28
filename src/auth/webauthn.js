// -----------------------------------------------------------------------------
// WebAuthn (passkeys) server side, with Node's crypto only.
// - "none" attestation: we trust the key the browser created, we do not ask
//   who made the authenticator (what passkey managers do anyway);
// - user verification (PIN, fingerprint, face) is REQUIRED: a passkey is then
//   two factors at once (the device + the PIN/biometrics);
// - keys: ES256 (-7), EdDSA (-8), RS256 (-257).
// -----------------------------------------------------------------------------

import { createPublicKey, verify } from 'node:crypto';
import { decode, decodeFirst } from './cbor.js';
import { b64url, fromB64url, safeEqual, sha256 } from './crypto.js';

export const ALGORITHMS = [-7, -8, -257];
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export class WebAuthnError extends Error {}
const fail = (message) => {
  throw new WebAuthnError(message);
};

export function registrationOptions({ rpId, rpName, user, challenge, exclude = [] }) {
  return {
    challenge,
    rp: { id: rpId, name: rpName },
    user: { id: user.handle, name: user.username, displayName: user.username },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout: 300_000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
  };
}

export function authenticationOptions({ rpId, challenge, allow = [] }) {
  return {
    challenge,
    rpId,
    timeout: 300_000,
    userVerification: 'required',
    allowCredentials: allow.map((id) => ({ type: 'public-key', id })),
  };
}

/** Reads the challenge from a credential sent by the browser (to find what it answers). */
export function challengeOf(credential) {
  try {
    return String(JSON.parse(fromB64url(credential?.response?.clientDataJSON).toString('utf8')).challenge ?? '');
  } catch {
    return '';
  }
}

function checkClientData(raw, { type, challenge, origin }) {
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('Réponse de la clé d’accès illisible.');
  }
  if (data.type !== type) fail('Réponse de la clé d’accès inattendue.');
  if (!challenge || !safeEqual(data.challenge, challenge)) fail('Défi expiré ou inconnu : recommencez.');
  if (data.origin !== origin) fail(`Adresse inattendue (${String(data.origin).slice(0, 100)}) : ouvrez l’appli avec ${origin}.`);
  if (data.crossOrigin === true) fail('Clé d’accès utilisée depuis un autre site.');
}

export function parseAuthData(buf) {
  if (buf.length < 37) fail('Données de la clé d’accès trop courtes.');
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32],
    signCount: buf.readUInt32BE(33),
  };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) fail('Données de la clé d’accès tronquées.');
    const idLength = buf.readUInt16BE(53);
    if (idLength > 1023 || buf.length < 55 + idLength) fail('Identifiant de clé invalide.');
    out.credentialId = Buffer.from(buf.subarray(55, 55 + idLength));
    const { value, length } = decodeFirst(buf.subarray(55 + idLength));
    out.cose = value;
    out.coseLength = length;
  }
  return out;
}

function checkAuthData(auth, rpId) {
  if (!auth.rpIdHash.equals(sha256(rpId))) fail('Clé d’accès créée pour un autre site.');
  if (!(auth.flags & FLAG_UP)) fail('Présence de l’utilisateur non confirmée.');
  if (!(auth.flags & FLAG_UV)) fail('Code PIN ou biométrie non vérifié par la clé d’accès.');
}

/** COSE key (Map) -> { publicKey: SPKI DER base64url, alg }. */
export function coseToSpki(cose) {
  if (!(cose instanceof Map)) fail('Clé publique invalide.');
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label) => {
    const v = cose.get(label);
    if (!Buffer.isBuffer(v)) fail('Clé publique incomplète.');
    return b64url(v);
  };
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) };
  else if (kty === 1 && alg === -8 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) };
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: bytes(-1), e: bytes(-2) };
  else fail('Type de clé non pris en charge (ES256, EdDSA ou RS256 attendu).');
  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    fail('Clé publique invalide.');
  }
  if (kty === 3 && key.asymmetricKeyDetails?.modulusLength < 2048) fail('Clé RSA trop courte.');
  return { publicKey: b64url(key.export({ type: 'spki', format: 'der' })), alg };
}

/**
 * Checks the answer of navigator.credentials.create().
 * @returns {{ credentialId, publicKey, alg, signCount, transports, backedUp }}
 */
export function verifyRegistration({ credential, challenge, origin, rpId }) {
  const response = credential?.response ?? {};
  if (credential?.type !== 'public-key') fail('Clé d’accès invalide.');
  checkClientData(fromB64url(response.clientDataJSON), { type: 'webauthn.create', challenge, origin });
  let attestation;
  try {
    attestation = decode(fromB64url(response.attestationObject));
  } catch {
    fail('Attestation de la clé d’accès illisible.');
  }
  const authData = attestation instanceof Map ? attestation.get('authData') : null;
  if (!Buffer.isBuffer(authData)) fail('Attestation de la clé d’accès incomplète.');
  const auth = parseAuthData(authData);
  checkAuthData(auth, rpId);
  if (!auth.credentialId) fail('La clé d’accès n’a pas envoyé de clé publique.');
  if (b64url(auth.credentialId) !== credential.id) fail('Identifiant de clé incohérent.');
  const { publicKey, alg } = coseToSpki(auth.cose);
  const transports = Array.isArray(response.transports)
    ? response.transports.filter((t) => typeof t === 'string' && /^[a-z-]{2,20}$/.test(t)).slice(0, 6)
    : [];
  return {
    credentialId: credential.id,
    publicKey,
    alg,
    signCount: auth.signCount,
    transports,
    backedUp: Boolean(auth.flags & FLAG_BE && auth.flags & FLAG_BS),
  };
}

/**
 * Checks the answer of navigator.credentials.get() against a stored passkey.
 * @returns {{ signCount }}
 */
export function verifyAuthentication({ credential, challenge, origin, rpId, passkey }) {
  const response = credential?.response ?? {};
  if (credential?.type !== 'public-key' || credential.id !== passkey.id) fail('Clé d’accès inconnue.');
  const clientData = fromB64url(response.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', challenge, origin });
  const authData = fromB64url(response.authenticatorData);
  const auth = parseAuthData(authData);
  checkAuthData(auth, rpId);

  const key = createPublicKey({ key: fromB64url(passkey.publicKey), format: 'der', type: 'spki' });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const signature = fromB64url(response.signature);
  let ok = false;
  try {
    if (passkey.alg === -8) ok = verify(null, signed, key, signature);
    else if (passkey.alg === -7) ok = verify('sha256', signed, { key, dsaEncoding: 'der' }, signature);
    else if (passkey.alg === -257) ok = verify('sha256', signed, key, signature);
  } catch {
    ok = false;
  }
  if (!ok) fail('Signature de la clé d’accès invalide.');

  // A counter that goes back means a cloned authenticator. Synced passkeys
  // always send 0: then there is nothing to compare.
  if ((auth.signCount || passkey.signCount) && auth.signCount <= passkey.signCount) {
    fail('Compteur de la clé d’accès incohérent (clé clonée ?) : connexion refusée.');
  }
  if (response.userHandle && passkey.userHandle && response.userHandle !== passkey.userHandle) {
    fail('Clé d’accès d’un autre utilisateur.');
  }
  return { signCount: auth.signCount };
}
