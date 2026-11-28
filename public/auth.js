// -----------------------------------------------------------------------------
// Accounts, browser side: login page (password, authenticator app, passkey,
// recovery code), first setup, "Mon compte" and "Utilisateurs" pages.
// -----------------------------------------------------------------------------

import { api, errorBox, field, formatDate, h, loading, setLoggedOutHandler, setView } from './ui.js';
import { qrSvg } from './qr.js';

const auth = { me: null, onReady: null };

export const currentUser = () => auth.me?.user ?? null;
export const isAdmin = () => currentUser()?.role === 'admin';
export const authDisabled = () => Boolean(auth.me?.authDisabled);

// --- base64url <-> bytes, WebAuthn calls ------------------------------------------

function toBytes(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function toB64url(buffer) {
  let bin = '';
  for (const byte of new Uint8Array(buffer)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const passkeysPossible = () => window.isSecureContext && 'PublicKeyCredential' in window;

const PASSKEY_HELP =
  'Les clés d’accès demandent une adresse en HTTPS avec un nom de domaine (ou http://localhost). ' +
  'Passez par votre reverse proxy pour les utiliser.';

function webauthnError(err) {
  if (err?.name === 'NotAllowedError') return 'Opération annulée ou délai dépassé.';
  if (err?.name === 'InvalidStateError') return 'Cette clé d’accès est déjà enregistrée sur cet appareil.';
  if (err?.name === 'SecurityError') return PASSKEY_HELP;
  return err?.message || 'Erreur de la clé d’accès.';
}

async function createPasskey(options) {
  const publicKey = {
    ...options,
    challenge: toBytes(options.challenge),
    user: { ...options.user, id: toBytes(options.user.id) },
    excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      attestationObject: toB64url(cred.response.attestationObject),
      transports: cred.response.getTransports?.() ?? [],
    },
  };
}

async function getPasskey(options) {
  const publicKey = {
    ...options,
    challenge: toBytes(options.challenge),
    allowCredentials: options.allowCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : null,
    },
  };
}

// --- small dialogs ----------------------------------------------------------------

/** Asks the current password in a modal. Resolves to the password, or null. */
function askPassword(message = 'Confirmez avec votre mot de passe.') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const dialog = h(
      'dialog',
      { class: 'modal' },
      h(
        'form',
        { method: 'dialog' },
        h('h2', {}, 'Confirmation'),
        h('p', {}, message),
        field('Mot de passe actuel', input),
        h(
          'div',
          { class: 'form-actions' },
          h('button', { class: 'button', type: 'submit', value: 'cancel', formnovalidate: true }, 'Annuler'),
          h('button', { class: 'button button-primary', type: 'submit', value: 'ok' }, 'Confirmer'),
        ),
      ),
    );
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value : null);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

/** Calls `fn(body)`; if the server asks for the password, asks it and retries. */
async function withPassword(fn) {
  try {
    return await fn({});
  } catch (err) {
    if (!err.details?.needPassword) throw err;
    const password = await askPassword();
    if (password === null) return null;
    return fn({ password });
  }
}

/** Shows the recovery codes once, with copy and download buttons. */
function recoveryBox(codes, { onDone, doneLabel = 'J’ai mis mes codes en lieu sûr' } = {}) {
  const text = `Codes de secours — External Integration Creator (${currentUser()?.username ?? ''})\n` +
    'Chaque code ne sert qu’une fois.\n\n' + codes.join('\n') + '\n';
  const download = h('a', { class: 'button small', download: 'codes-de-secours.txt' }, 'Télécharger (.txt)');
  download.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  return h(
    'div',
    { class: 'alert alert-warn recovery' },
    h('strong', {}, 'Codes de secours : notez-les maintenant, ils ne seront plus affichés.'),
    h('p', { class: 'small' }, 'Ils remplacent la double authentification si vous perdez votre téléphone ou votre clé. Chaque code ne sert qu’une fois.'),
    h('ul', { class: 'codes' }, codes.map((c) => h('li', {}, h('code', {}, c)))),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'button small',
          type: 'button',
          onclick: async (e) => {
            await navigator.clipboard?.writeText(text).catch(() => {});
            e.target.textContent = 'Copié';
          },
        },
        'Copier',
      ),
      download,
      onDone ? h('button', { class: 'button button-primary small', type: 'button', onclick: onDone }, doneLabel) : null,
    ),
  );
}

// --- start, login, setup -----------------------------------------------------------

async function refreshMe() {
  auth.me = await api('auth/me');
  return auth.me;
}

function setLoggedOut(loggedOut) {
  document.body.classList.toggle('logged-out', loggedOut);
}

/** Top bar: user name, account link, logout; "Utilisateurs" for admins. */
function renderUserBox() {
  const box = document.getElementById('user-box');
  const usersLink = document.querySelector('[data-nav="users"]');
  if (usersLink) usersLink.hidden = !isAdmin() || authDisabled();
  if (!box) return;
  const user = currentUser();
  if (!user || authDisabled()) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    h('a', { href: '#/compte', class: 'user-link', 'data-nav': 'account', title: `Mon compte (${user.roleLabel})` }, h('span', { class: 'user-name' }, user.username)),
    h('button', { class: 'button small', type: 'button', onclick: logout }, 'Déconnexion'),
  );
}

async function logout() {
  await api('auth/logout', { method: 'POST' }).catch(() => {});
  auth.me = null;
  location.hash = '#/';
  showLogin();
}

/**
 * Entry point: decides between setup, login, forced steps and the app.
 * `onReady` starts the app once the user is fully logged in.
 */
export async function authStart(onReady) {
  if (onReady) auth.onReady = onReady;
  setLoggedOutHandler(() => {
    if (auth.me?.user) {
      auth.me = null;
      showLogin('Session expirée : reconnectez-vous.');
    }
  });
  try {
    await refreshMe();
  } catch (err) {
    setView(errorBox(err.message));
    return;
  }
  if (auth.me.needsSetup) return showSetup();
  if (!auth.me.user) return showLogin();
  if (auth.me.access !== 'full') return showForced();
  setLoggedOut(false);
  renderUserBox();
  return auth.onReady?.();
}

async function loggedIn(result) {
  if (result?.recoveryLeft !== undefined && result.recoveryLeft <= 3) {
    alert(`Il vous reste ${result.recoveryLeft} code(s) de secours : générez-en de nouveaux dans « Mon compte ».`);
  }
  return authStart();
}

function authCard(title, ...children) {
  setLoggedOut(true);
  renderUserBox();
  setView(h('section', { class: 'auth-card' }, h('h1', {}, title), ...children));
}

function showLogin(notice) {
  const error = h('div');
  const username = h('input', { type: 'text', autocomplete: 'username webauthn', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });

  const fail = (err) => error.replaceChildren(errorBox(err.message ?? String(err)));

  const passkeyLogin = async (button, ticket) => {
    error.replaceChildren();
    button.disabled = true;
    try {
      const options = await api('auth/passkey/options', { method: 'POST', body: ticket ? { ticket } : {} });
      let credential;
      try {
        credential = await getPasskey(options);
      } catch (err) {
        throw new Error(webauthnError(err));
      }
      await loggedIn(await api('auth/passkey/login', { method: 'POST', body: { credential } }));
    } catch (err) {
      fail(err);
      button.disabled = false;
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    error.replaceChildren();
    const submit = e.target.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const result = await api('auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
      if (result.mfa) return showSecondFactor(result.mfa, passkeyLogin);
      await loggedIn(result);
    } catch (err) {
      fail(err);
      submit.disabled = false;
    }
    return undefined;
  };

  const passkeyButton = h('button', { class: 'button button-wide', type: 'button', onclick: (e) => passkeyLogin(e.currentTarget) }, '🔑 Se connecter avec une clé d’accès');

  authCard(
    'Connexion',
    notice ? h('div', { class: 'alert alert-warn' }, notice) : null,
    h(
      'form',
      { class: 'auth-form', onsubmit: onSubmit },
      field('Nom d’utilisateur', username),
      field('Mot de passe', password),
      error,
      h('button', { class: 'button button-primary button-wide', type: 'submit' }, 'Se connecter'),
    ),
    h('p', { class: 'auth-sep' }, 'ou'),
    passkeysPossible() ? passkeyButton : h('p', { class: 'muted small' }, PASSKEY_HELP),
  );
  username.focus();
}

function showSecondFactor({ ticket, methods }, passkeyLogin) {
  const error = h('div');
  const fail = (err) => error.replaceChildren(errorBox(err.message));
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxlength: 7, required: true, class: 'otp' });
  const recovery = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'xxxxx-xxxxx' });

  const submit = (path, body) => async (e) => {
    e.preventDefault();
    error.replaceChildren();
    const button = e.target.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await loggedIn(await api(path, { method: 'POST', body: { ticket, ...body() } }));
    } catch (err) {
      fail(err);
      button.disabled = false;
      if (/mot de passe/.test(err.message)) setTimeout(() => showLogin(err.message), 1500);
    }
  };

  const recoveryForm = h(
    'form',
    { class: 'auth-form', hidden: methods.includes('totp') || methods.includes('passkey'), onsubmit: submit('auth/login/recovery', () => ({ code: recovery.value })) },
    field('Code de secours', recovery, { hint: 'Un des 10 codes notés à l’activation. Il ne servira qu’une fois.' }),
    h('button', { class: 'button button-primary button-wide', type: 'submit' }, 'Valider'),
  );

  authCard(
    'Double authentification',
    methods.includes('totp')
      ? h(
          'form',
          { class: 'auth-form', onsubmit: submit('auth/login/totp', () => ({ code: code.value })) },
          field('Code de l’application d’authentification', code, { hint: '6 chiffres, renouvelés toutes les 30 secondes.' }),
          h('button', { class: 'button button-primary button-wide', type: 'submit' }, 'Valider'),
        )
      : null,
    methods.includes('passkey')
      ? [
          methods.includes('totp') ? h('p', { class: 'auth-sep' }, 'ou') : null,
          passkeysPossible()
            ? h('button', { class: 'button button-wide', type: 'button', onclick: (e) => passkeyLogin(e.currentTarget, ticket) }, '🔑 Utiliser ma clé d’accès')
            : h('p', { class: 'muted small' }, PASSKEY_HELP),
        ]
      : null,
    error,
    recoveryForm,
    methods.includes('recovery') && recoveryForm.hidden
      ? h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); recoveryForm.hidden = false; e.target.remove(); recovery.focus(); } }, 'Utiliser un code de secours'))
      : null,
    h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); showLogin(); } }, '← Retour')),
  );
  if (methods.includes('totp')) code.focus();
}

function showSetup() {
  const error = h('div');
  const code = h('input', { type: 'text', autocomplete: 'off', required: true, spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX' });
  const username = h('input', { type: 'text', autocomplete: 'username', required: true, value: 'admin' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const confirmPw = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  authCard(
    'Première installation',
    h('p', {}, 'Créez le compte administrateur. Le code d’installation est affiché dans les journaux du conteneur :'),
    h('pre', { class: 'cmd' }, 'docker compose logs external-integration-creator | grep installation'),
    h(
      'form',
      {
        class: 'auth-form',
        onsubmit: async (e) => {
          e.preventDefault();
          error.replaceChildren();
          if (password.value !== confirmPw.value) return error.replaceChildren(errorBox('Les deux mots de passe sont différents.'));
          try {
            await loggedIn(await api('auth/setup', { method: 'POST', body: { code: code.value, username: username.value, password: password.value } }));
          } catch (err) {
            error.replaceChildren(errorBox(err.message));
          }
          return undefined;
        },
      },
      field('Code d’installation', code),
      field('Nom d’utilisateur', username),
      field('Mot de passe', password, { hint: '12 caractères minimum. Une phrase de plusieurs mots est idéale.' }),
      field('Confirmer le mot de passe', confirmPw),
      error,
      h('button', { class: 'button button-primary button-wide', type: 'submit' }, 'Créer le compte'),
    ),
  );
  code.focus();
}

/** Logged in, but the password must change or a 2nd factor must be added first. */
async function showForced() {
  setLoggedOut(true);
  renderUserBox();
  const logoutLink = h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, 'Se déconnecter'));
  if (auth.me.access === 'password') {
    return authCard(
      'Nouveau mot de passe',
      h('p', {}, 'Votre mot de passe est temporaire : choisissez-en un nouveau pour continuer.'),
      passwordForm(() => authStart()),
      logoutLink,
    );
  }
  const account = await api('account');
  return authCard(
    'Double authentification',
    h('p', {}, 'Elle est obligatoire sur cette appli : ajoutez au moins une méthode pour continuer.'),
    mfaSection(account, { onChange: () => authStart(), forced: true }),
    logoutLink,
  );
}

// --- my account ---------------------------------------------------------------------

function passwordForm(onDone) {
  const error = h('div');
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const confirmPw = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  return h(
    'form',
    {
      class: 'auth-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.replaceChildren();
        if (next.value !== confirmPw.value) return error.replaceChildren(errorBox('Les deux mots de passe sont différents.'));
        try {
          await api('account/password', { method: 'POST', body: { current: current.value, password: next.value } });
          error.replaceChildren(h('div', { class: 'alert alert-ok' }, 'Mot de passe changé. Vos autres sessions sont fermées.'));
          e.target.reset();
          onDone?.();
        } catch (err) {
          error.replaceChildren(errorBox(err.message));
        }
        return undefined;
      },
    },
    field('Mot de passe actuel', current),
    field('Nouveau mot de passe', next, { hint: '12 caractères minimum, sans votre nom d’utilisateur.' }),
    field('Confirmer', confirmPw),
    error,
    h('div', { class: 'form-actions' }, h('button', { class: 'button button-primary', type: 'submit' }, 'Changer le mot de passe')),
  );
}

function totpSetup(box, onEnabled) {
  const error = h('div');
  box.replaceChildren(loading());
  withPassword((body) => api('account/totp/setup', { method: 'POST', body }))
    .then((setup) => {
      if (!setup) return box.replaceChildren();
      const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, class: 'otp' });
      box.replaceChildren(
        h(
          'div',
          { class: 'totp-setup' },
          h('ol', {},
            h('li', {}, 'Ouvrez votre application d’authentification (Aegis, 2FAS, Google Authenticator, Bitwarden, 1Password…).'),
            h('li', {}, 'Scannez ce QR code, ou entrez la clé à la main.'),
            h('li', {}, 'Tapez le code à 6 chiffres affiché par l’application.'),
          ),
          h('div', { class: 'qr' }, qrSvg(setup.uri, { label: 'QR code à scanner avec l’application d’authentification' })),
          h('p', { class: 'small' }, 'Clé : ', h('code', { class: 'secret' }, setup.secret.replace(/(.{4})/g, '$1 ').trim())),
          h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); location.href = setup.uri; } }, 'Ouvrir dans l’application (sur ce téléphone)')),
          h(
            'form',
            {
              class: 'row',
              onsubmit: async (e) => {
                e.preventDefault();
                error.replaceChildren();
                try {
                  const result = await api('account/totp/enable', { method: 'POST', body: { code: code.value } });
                  onEnabled(result);
                } catch (err) {
                  error.replaceChildren(errorBox(err.message));
                }
              },
            },
            code,
            h('button', { class: 'button button-primary', type: 'submit' }, 'Valider le code'),
          ),
          error,
        ),
      );
      code.focus();
      return undefined;
    })
    .catch((err) => box.replaceChildren(errorBox(err.message)));
}

/** Second factors: authenticator app, passkeys, recovery codes. */
function mfaSection(account, { onChange, forced = false }) {
  const out = h('div', { class: 'mfa' });
  const message = h('div');
  const done = (result) => {
    if (result?.recoveryCodes) {
      out.replaceChildren(recoveryBox(result.recoveryCodes, { onDone: onChange, doneLabel: forced ? 'Continuer' : 'OK' }));
    } else onChange();
  };
  const run = async (fn) => {
    message.replaceChildren();
    try {
      const result = await fn();
      if (result !== null) done(result);
    } catch (err) {
      message.replaceChildren(errorBox(err.message));
    }
  };

  // Authenticator app.
  const totpBox = h('div');
  const totp = h(
    'div',
    { class: 'mfa-method' },
    h('div', { class: 'mfa-head' },
      h('h3', {}, 'Application d’authentification'),
      account.totp ? h('span', { class: 'badge st-done' }, 'activée') : h('span', { class: 'badge' }, 'non activée'),
    ),
    h('p', { class: 'muted small' }, 'Un code à 6 chiffres sur votre téléphone, renouvelé toutes les 30 secondes.'),
    account.totp
      ? h('button', {
          class: 'button small',
          type: 'button',
          onclick: () => {
            if (!confirm('Retirer l’application d’authentification ?')) return;
            run(() => withPassword((body) => api('account/totp/disable', { method: 'POST', body })));
          },
        }, 'Retirer')
      : h('button', {
          class: 'button button-primary small',
          type: 'button',
          onclick: (e) => {
            e.currentTarget.hidden = true;
            totpSetup(totpBox, done);
          },
        }, 'Activer'),
    totpBox,
  );

  // Passkeys.
  const name = h('input', { type: 'text', placeholder: 'Nom (ex. Téléphone, YubiKey)', maxlength: 60 });
  const addPasskey = async (button) => {
    button.disabled = true;
    await run(async () => {
      const options = await withPassword((body) => api('account/passkeys/options', { method: 'POST', body }));
      if (!options) return null;
      let credential;
      try {
        credential = await createPasskey(options);
      } catch (err) {
        throw new Error(webauthnError(err));
      }
      return api('account/passkeys', { method: 'POST', body: { credential, name: name.value } });
    });
    button.disabled = false;
  };
  const passkeys = h(
    'div',
    { class: 'mfa-method' },
    h('div', { class: 'mfa-head' },
      h('h3', {}, 'Clés d’accès (passkeys)'),
      h('span', { class: `badge ${account.passkeys ? 'st-done' : ''}` }, account.passkeys ? `${account.passkeys} enregistrée(s)` : 'aucune'),
    ),
    h('p', { class: 'muted small' }, 'Empreinte, visage, code PIN du téléphone ou clé de sécurité (YubiKey…). Protège contre l’hameçonnage, et permet de se connecter sans mot de passe.'),
    account.passkeyList.length
      ? h('ul', { class: 'list' }, account.passkeyList.map((p) =>
          h('li', {},
            h('span', { class: 'list-main' }, h('strong', {}, p.name), p.backedUp ? h('span', { class: 'badge badge-info' }, 'synchronisée') : null,
              h('span', { class: 'muted small' }, ` ajoutée le ${formatDate(p.createdAt)}${p.lastUsedAt ? `, utilisée le ${formatDate(p.lastUsedAt)}` : ''}`)),
            h('span', { class: 'row' },
              h('button', { class: 'button small', type: 'button', onclick: () => {
                const value = prompt('Nouveau nom de la clé d’accès :', p.name);
                if (value) run(() => api(`account/passkeys/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { name: value } }));
              } }, 'Renommer'),
              h('button', { class: 'button small', type: 'button', onclick: () => {
                if (!confirm(`Supprimer la clé d’accès « ${p.name} » ? Pensez à la retirer aussi de l’appareil.`)) return;
                run(() => withPassword((body) => api(`account/passkeys/${encodeURIComponent(p.id)}/delete`, { method: 'POST', body })));
              } }, 'Supprimer'),
            ),
          )))
      : null,
    passkeysPossible()
      ? h('div', { class: 'row' }, name, h('button', { class: 'button button-primary small', type: 'button', onclick: (e) => addPasskey(e.currentTarget) }, 'Ajouter une clé d’accès'))
      : h('p', { class: 'alert alert-warn small' }, PASSKEY_HELP),
  );

  // Recovery codes.
  const recovery = account.mfa
    ? h(
        'div',
        { class: 'mfa-method' },
        h('div', { class: 'mfa-head' },
          h('h3', {}, 'Codes de secours'),
          h('span', { class: `badge ${account.recoveryLeft > 3 ? 'st-done' : 'badge-warn'}` }, `${account.recoveryLeft} restant(s)`),
        ),
        h('p', { class: 'muted small' }, 'Pour vous connecter si vous perdez votre téléphone ou votre clé. Générer de nouveaux codes annule les anciens.'),
        h('button', {
          class: 'button small',
          type: 'button',
          onclick: () => {
            if (!confirm('Générer 10 nouveaux codes ? Les anciens ne marcheront plus.')) return;
            run(() => withPassword((body) => api('account/recovery', { method: 'POST', body })));
          },
        }, 'Générer de nouveaux codes'),
      )
    : null;

  out.append(totp, passkeys, recovery ?? '', message);
  return out;
}

const UA_RULES = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const OS_RULES = [
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
];

function describeUa(ua) {
  const browser = UA_RULES.find(([re]) => re.test(ua))?.[1];
  const os = OS_RULES.find(([re]) => re.test(ua))?.[1];
  return [browser, os].filter(Boolean).join(' sur ') || (ua ? ua.slice(0, 40) : 'Inconnu');
}

function sessionsSection(account, refresh) {
  const message = h('div');
  const act = async (path) => {
    try {
      await api(path, { method: 'POST' });
      refresh();
    } catch (err) {
      message.replaceChildren(errorBox(err.message));
    }
  };
  return h(
    'div',
    {},
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Appareil'), h('th', {}, 'Adresse IP'), h('th', {}, 'Connexion'), h('th', {}, 'Dernière activité'), h('th', {}, ''))),
      h('tbody', {}, account.sessionList.map((s) =>
        h('tr', {},
          h('td', {}, describeUa(s.userAgent), s.current ? [' ', h('span', { class: 'badge st-done' }, 'cette session')] : null),
          h('td', {}, h('code', {}, s.ip || '?')),
          h('td', {}, formatDate(s.createdAt), h('div', { class: 'muted small' }, s.method)),
          h('td', {}, formatDate(s.lastSeenAt)),
          h('td', {}, s.current ? null : h('button', { class: 'button small', type: 'button', onclick: () => act(`account/sessions/${encodeURIComponent(s.id)}/revoke`) }, 'Fermer')),
        ))),
    )),
    account.sessionList.length > 1
      ? h('button', { class: 'button small', type: 'button', onclick: () => act('account/sessions/revoke-others') }, 'Fermer toutes les autres sessions')
      : null,
    message,
  );
}

export async function showAccount() {
  if (authDisabled()) {
    return setView(h('h1', {}, 'Mon compte'), h('div', { class: 'alert alert-info' }, 'Comptes désactivés (NO_PASSWORD=true) : c’est le reverse proxy qui authentifie.'));
  }
  setView(h('h1', {}, 'Mon compte'), loading());
  let account;
  try {
    account = await api('account');
  } catch (err) {
    return setView(h('h1', {}, 'Mon compte'), errorBox(err.message));
  }
  const refresh = async () => {
    await refreshMe().catch(() => {});
    renderUserBox();
    showAccount();
  };
  return setView(
    h('h1', {}, 'Mon compte'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Utilisateur'), h('dd', {}, account.username),
      h('dt', {}, 'Rôle'), h('dd', {}, account.roleLabel),
      h('dt', {}, 'Dernière connexion'), h('dd', {}, account.lastLoginAt ? formatDate(account.lastLoginAt) : '—'),
    ),
    h('section', { class: 'panel' }, h('h2', {}, 'Double authentification'),
      !account.mfa ? h('div', { class: 'alert alert-warn' }, 'Aucune double authentification : votre compte n’est protégé que par le mot de passe.') : null,
      mfaSection(account, { onChange: refresh })),
    h('section', { class: 'panel' }, h('h2', {}, 'Mot de passe'), passwordForm()),
    h('section', { class: 'panel' }, h('h2', {}, 'Sessions ouvertes'), sessionsSection(account, refresh)),
  );
}

// --- users (administrators) -----------------------------------------------------------

export async function showUsers(notice) {
  if (authDisabled()) {
    return setView(h('h1', {}, 'Utilisateurs'), h('div', { class: 'alert alert-info' }, 'Comptes désactivés (NO_PASSWORD=true).'));
  }
  if (!isAdmin()) return setView(h('h1', {}, 'Utilisateurs'), errorBox('Réservé aux administrateurs.'));
  setView(h('h1', {}, 'Utilisateurs'), loading());
  let data;
  let audit;
  try {
    [data, audit] = await Promise.all([api('users'), api('users/audit')]);
  } catch (err) {
    return setView(h('h1', {}, 'Utilisateurs'), errorBox(err.message));
  }
  const me = currentUser();
  const message = h('div', { class: 'notice' }, notice ?? null);
  // The page is redrawn after each change: the notice goes into the new one.
  const showTempPassword = (username, password) =>
    showUsers(
      h('div', { class: 'alert alert-ok' },
        `Mot de passe temporaire de ${username} : `, h('code', { class: 'secret' }, password),
        h('div', { class: 'small' }, 'Transmettez-le par un canal sûr. Il devra être changé à la première connexion. Il ne sera plus affiché.')),
    );
  const act = async (fn, after) => {
    message.replaceChildren();
    try {
      const result = await fn();
      if (after) after(result);
      else showUsers();
    } catch (err) {
      message.replaceChildren(errorBox(err.message));
    }
  };

  // Security policy.
  const requireMfa = h('input', {
    type: 'checkbox',
    checked: data.security.requireMfa,
    onchange: (e) => act(() => api('security', { method: 'PUT', body: { requireMfa: e.target.checked } })),
  });

  // New user.
  const username = h('input', { type: 'text', required: true, autocomplete: 'off', spellcheck: 'false' });
  const role = h('select', {}, data.roles.map((r) => h('option', { value: r.key, selected: r.key === 'member' }, r.label)));
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Vide = généré' });
  const createForm = h(
    'form',
    {
      class: 'user-create',
      onsubmit: (e) => {
        e.preventDefault();
        act(
          () => api('users', { method: 'POST', body: { username: username.value, role: role.value, password: password.value || undefined } }),
          (result) => {
            if (result.password) showTempPassword(result.user.username, result.password);
            else showUsers(h('div', { class: 'alert alert-ok' }, `Compte ${result.user.username} créé (mot de passe temporaire à changer à la première connexion).`));
          },
        );
      },
    },
    field('Nom d’utilisateur', username),
    field('Rôle', role),
    field('Mot de passe temporaire', password),
    h('button', { class: 'button button-primary', type: 'submit' }, 'Créer'),
  );

  const userRow = (u) => {
    const self = u.id === me?.id;
    const roleSelect = h(
      'select',
      { 'aria-label': `Rôle de ${u.username}`, onchange: (e) => act(() => api(`users/${u.id}`, { method: 'PUT', body: { role: e.target.value } })) },
      data.roles.map((r) => h('option', { value: r.key, selected: r.key === u.role }, r.label)),
    );
    const mfa = [u.totp ? 'appli' : null, u.passkeys ? `${u.passkeys} clé(s)` : null].filter(Boolean).join(' + ');
    const menu = h(
      'details',
      { class: 'menu' },
      h('summary', { class: 'button small' }, 'Actions'),
      h('div', { class: 'menu-items' },
        h('button', { type: 'button', onclick: () => {
          if (confirm(`Réinitialiser le mot de passe de ${u.username} ? Un mot de passe temporaire sera généré.`)) {
            act(() => api(`users/${u.id}/password`, { method: 'POST', body: {} }), (r) => showTempPassword(u.username, r.password));
          }
        } }, 'Réinitialiser le mot de passe'),
        h('button', { type: 'button', disabled: !u.mfa, onclick: () => {
          if (confirm(`Retirer la double authentification de ${u.username} (appli, clés d’accès, codes de secours) ?`)) act(() => api(`users/${u.id}/reset-mfa`, { method: 'POST' }));
        } }, 'Réinitialiser la double authentification'),
        h('button', { type: 'button', disabled: !u.sessions, onclick: () => act(() => api(`users/${u.id}/sessions/revoke`, { method: 'POST' })) }, 'Fermer ses sessions'),
        self ? null : h('button', { type: 'button', onclick: () => act(() => api(`users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } })) }, u.disabled ? 'Réactiver' : 'Désactiver'),
        self ? null : h('button', { type: 'button', class: 'danger', onclick: () => {
          if (confirm(`Supprimer définitivement le compte ${u.username} ?`)) act(() => api(`users/${u.id}`, { method: 'DELETE' }));
        } }, 'Supprimer'),
      ),
    );
    return h('tr', { class: u.disabled ? 'row-disabled' : null },
      h('td', {}, h('strong', {}, u.username), self ? h('span', { class: 'muted small' }, ' (vous)') : null,
        u.disabled ? [' ', h('span', { class: 'badge badge-warn' }, 'désactivé')] : null,
        u.mustChangePassword ? [' ', h('span', { class: 'badge' }, 'mot de passe temporaire')] : null),
      h('td', {}, roleSelect),
      h('td', {}, mfa ? h('span', { class: 'badge st-done' }, mfa) : h('span', { class: `badge ${data.security.requireMfa ? 'badge-warn' : ''}` }, 'aucune')),
      h('td', {}, u.lastLoginAt ? formatDate(u.lastLoginAt) : '—', u.sessions ? h('div', { class: 'muted small' }, `${u.sessions} session(s)`) : null),
      h('td', {}, menu),
    );
  };

  return setView(
    h('h1', {}, 'Utilisateurs'),
    h('section', { class: 'panel' },
      h('label', { class: 'check-line' }, requireMfa, ' Double authentification obligatoire pour tous'),
      h('p', { class: 'muted small' }, 'Les comptes sans double authentification devront en ajouter une à leur prochaine connexion avant de pouvoir utiliser l’appli.'),
    ),
    message,
    h('section', { class: 'panel' },
      h('h2', {}, 'Comptes'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Utilisateur'), h('th', {}, 'Rôle'), h('th', {}, 'Double auth.'), h('th', {}, 'Dernière connexion'), h('th', {}, ''))),
          h('tbody', {}, data.users.map(userRow)),
        )),
      h('p', { class: 'muted small' }, 'Administrateur : tout, dont les jetons et les comptes. Membre : lance et publie des intégrations. Lecteur : consulte seulement.'),
    ),
    h('section', { class: 'panel' }, h('h2', {}, 'Nouveau compte'), createForm),
    h('section', { class: 'panel' },
      h('h2', {}, 'Journal'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'table table-compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Action'), h('th', {}, 'Par'), h('th', {}, 'Compte visé'), h('th', {}, 'IP'))),
          h('tbody', {}, audit.entries.map((e) =>
            h('tr', { class: e.ok ? null : 'row-fail' },
              h('td', {}, formatDate(e.at)), h('td', {}, e.action), h('td', {}, e.actor ?? ''), h('td', {}, e.target ?? ''), h('td', {}, e.ip ? h('code', {}, e.ip) : ''),
            ))),
        )),
    ),
  );
}
