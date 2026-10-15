// The Passkeys panel, opened from the help overlay: lists this server's
// passkeys, adds one (only through the https address: WebAuthn needs a real
// hostname), deletes one, and signs out.
//
// The server side is src/auth.ts (/api/auth, /api/passkeys…). The sign-in
// itself happens on the login page, which has its own small script because it
// is served before the app's bundle can load.

import { activeSession } from './state.js';

interface AuthInfo {
  viaCloudflare: boolean;
  method: 'token' | 'passkey' | 'legacy' | null;
  passkeyCapable: boolean;
}

interface PasskeyInfo {
  id: string;
  name: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** The parts of the server's PublicKeyCredentialCreationOptionsJSON used here. */
interface CreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: { id: string; transports?: string[] }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

interface RegisterOptions {
  challengeId: string;
  options: CreationOptionsJSON;
}

/** A fetched challenge is good for five minutes; use one only while it is well inside that. */
const OPTIONS_FRESH_MS = 4 * 60 * 1000;
const NAME_MAX = 64;

function toBuf(s: string): ArrayBuffer {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64u(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function webauthnSupported(): boolean {
  return typeof window.PublicKeyCredential === 'function' && window.isSecureContext;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON: the login page, after a sign-out elsewhere */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

function fmtDate(ms: number | null): string {
  if (ms === null) return 'never';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function button(text: string, cls = 'tb-btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
}

/** Leave the session: a real form POST, so the browser follows to the login page. */
function signOut(): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = '/logout';
  form.style.display = 'none';
  document.body.append(form);
  form.submit();
}

export function openPasskeys(): void {
  if (document.querySelector('.passkeys-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay passkeys-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box help-box passkeys-box';

  const title = document.createElement('div');
  title.className = 'help-title';
  title.textContent = 'Passkeys';
  const intro = document.createElement('div');
  intro.className = 'pk-note';
  intro.textContent =
    'Sign in through the https address with a passkey instead of the token. The token keeps working.';
  const list = document.createElement('ul');
  list.className = 'pk-list';
  const status = document.createElement('div');
  status.className = 'pk-status';
  status.setAttribute('role', 'status');

  const addRow = document.createElement('div');
  addRow.className = 'pk-add';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'prompt-input pk-name';
  nameInput.placeholder = 'Name (optional)';
  nameInput.maxLength = NAME_MAX;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  const addBtn = button('Add a passkey', 'tb-btn pk-add-btn');
  addBtn.disabled = true;
  addRow.append(nameInput, addBtn);
  const hint = document.createElement('div');
  hint.className = 'pk-note';
  hint.hidden = true;

  const row = document.createElement('div');
  row.className = 'paste-row';
  const signOutBtn = button('Sign out', 'tb-btn pk-signout');
  signOutBtn.hidden = true;
  const closeBtn = button('Close');
  row.append(signOutBtn, closeBtn);

  box.append(title, intro, list, status, addRow, hint, row);
  overlay.append(box);
  document.body.append(overlay);

  let open = true;
  /** Whether this page may add a passkey: through Cloudflare, with WebAuthn. */
  let canAdd = false;
  const close = (): void => {
    open = false;
    overlay.remove();
    activeSession?.focus();
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  signOutBtn.addEventListener('click', signOut);

  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('pk-error', isError);
  };

  // --- list ----------------------------------------------------------------
  const renderList = (items: PasskeyInfo[]): void => {
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'pk-empty';
      li.textContent = 'No passkeys yet.';
      list.append(li);
      return;
    }
    for (const p of items) {
      const li = document.createElement('li');
      li.className = 'pk-item';
      const text = document.createElement('div');
      text.className = 'pk-text';
      const name = document.createElement('div');
      name.className = 'pk-item-name';
      name.textContent = p.name;
      const meta = document.createElement('div');
      meta.className = 'pk-meta';
      meta.textContent = `${p.rpId} · added ${fmtDate(p.createdAt)} · last used ${fmtDate(p.lastUsedAt)}`;
      text.append(name, meta);
      const del = button('Delete', 'tb-btn pk-del');
      // Two taps: the first arms it for a few seconds. No native confirm():
      // an installed iOS web app can hang on it.
      let armed = 0;
      del.addEventListener('click', () => {
        if (!armed) {
          del.textContent = 'Delete?';
          del.classList.add('pk-armed');
          armed = window.setTimeout(() => {
            armed = 0;
            del.textContent = 'Delete';
            del.classList.remove('pk-armed');
          }, 4000);
          return;
        }
        window.clearTimeout(armed);
        armed = 0;
        del.disabled = true;
        void (async () => {
          const r = await postJson('/api/passkeys/delete', { id: p.id });
          if (r.ok) say(`Deleted "${p.name}".`);
          else say(String(r.body?.error ?? 'Could not delete it.'), true);
          await refresh();
        })();
      });
      li.append(text, del);
      list.append(li);
    }
  };

  // --- add -----------------------------------------------------------------
  // Options are fetched ahead of the tap: Safari wants
  // navigator.credentials.create called from the tap itself, and a network
  // round-trip in between can use that permission up.
  let ready: Promise<RegisterOptions | null> | null = null;
  let readyAt = 0;
  const prefetch = (): void => {
    readyAt = Date.now();
    ready = (async () => {
      const r = await postJson('/api/passkeys/register/options', {});
      if (!r.ok || !r.body) {
        if (r.body?.error) say(String(r.body.error), true);
        return null;
      }
      return r.body as unknown as RegisterOptions;
    })();
  };

  addBtn.addEventListener('click', () => {
    if (addBtn.disabled) return;
    addBtn.disabled = true;
    say('');
    void (async () => {
      try {
        if (!ready || Date.now() - readyAt > OPTIONS_FRESH_MS) prefetch();
        const got = await ready;
        ready = null;
        if (!got) {
          say('Could not start adding a passkey.', true);
          return;
        }
        const o = got.options;
        let cred: PublicKeyCredential | null;
        try {
          cred = (await navigator.credentials.create({
            publicKey: {
              challenge: toBuf(o.challenge),
              rp: o.rp,
              user: { id: toBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
              pubKeyCredParams: o.pubKeyCredParams,
              timeout: o.timeout,
              excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({
                type: 'public-key' as const,
                id: toBuf(c.id),
                transports: c.transports as AuthenticatorTransport[] | undefined,
              })),
              authenticatorSelection: o.authenticatorSelection,
              attestation: o.attestation,
            },
          })) as PublicKeyCredential | null;
        } catch (e) {
          const n = (e as Error)?.name;
          say(
            n === 'InvalidStateError'
              ? 'This device already has a passkey for this site.'
              : n === 'NotAllowedError'
                ? 'Cancelled.'
                : `Could not create a passkey (${n || 'error'}).`,
            true,
          );
          return;
        }
        if (!cred) {
          say('Cancelled.', true);
          return;
        }
        const r = cred.response as AuthenticatorAttestationResponse;
        const v = await postJson('/api/passkeys/register/verify', {
          challengeId: got.challengeId,
          name: nameInput.value.trim().slice(0, NAME_MAX) || undefined,
          response: {
            id: cred.id,
            rawId: toB64u(cred.rawId),
            type: cred.type,
            authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
            clientExtensionResults: cred.getClientExtensionResults(),
            response: {
              clientDataJSON: toB64u(r.clientDataJSON),
              attestationObject: toB64u(r.attestationObject),
              transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
            },
          },
        });
        if (v.ok) {
          nameInput.value = '';
          say(`Added "${String(v.body?.name ?? 'passkey')}".`);
        } else {
          say(String(v.body?.error ?? 'Could not add the passkey.'), true);
        }
        await refresh();
      } finally {
        // A fresh challenge for the next try; the one just used is spent.
        if (open && canAdd) {
          addBtn.disabled = false;
          if (!ready) prefetch();
        }
      }
    })();
  });

  // --- state ---------------------------------------------------------------
  const refresh = async (): Promise<void> => {
    const [auth, items] = await Promise.all([
      getJson<AuthInfo>('/api/auth'),
      getJson<PasskeyInfo[]>('/api/passkeys'),
    ]);
    if (!open) return;
    if (!auth || !Array.isArray(items)) {
      // Most likely signed out (the passkey this session used was deleted).
      renderList([]);
      say('Not signed in any more. Reload the page to sign in again.', true);
      canAdd = false;
      addBtn.disabled = true;
      return;
    }
    renderList(items);
    signOutBtn.hidden = !auth.viaCloudflare;
    const wasAble = canAdd;
    canAdd = auth.passkeyCapable && webauthnSupported();
    addBtn.disabled = !canAdd;
    addRow.hidden = !auth.passkeyCapable;
    hint.hidden = canAdd;
    hint.textContent = auth.passkeyCapable
      ? "This browser can't create passkeys here."
      : 'Open this page through its https address to add a passkey.';
    if (canAdd && !wasAble && !ready) prefetch();
  };
  void refresh();
}
