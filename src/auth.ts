/**
 * Request gating: sign-in for Cloudflare-fronted requests, and the Host /
 * Origin checks every request goes through.
 *
 * Sign-in: a request that arrives through Cloudflare must carry a valid
 * `tw_auth` cookie, or it gets a small login page. Two ways to get one:
 *
 *   * the shared token: the page POSTs it to /login. Supplying `?token=…` on a
 *     GET still works for old bookmarks: it signs in and redirects to the same
 *     URL without it. The token is always accepted; it is never switched off.
 *   * a passkey (WebAuthn), registered beforehand from the app (see
 *     passkeys.ts). Optional: with none registered, the token is all there is.
 *
 * Either way the cookie holds a random session id the server issued, never the
 * token itself (see auth-store.ts). A cookie that still holds the token, from
 * before sessions existed, is accepted and swapped for a session on the spot.
 *
 * The token is a single shared secret, not per-user identity — keep it long
 * and random. Direct/tailnet access needs no sign-in, by design. With
 * `AUTH_TOKEN` empty, a Cloudflare-fronted request is refused outright: it
 * used to be let straight in, which made a tunnel set up before the token a
 * public shell.
 */
import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { issueSession, lookupSession, removePasskey, revokeSession } from "./auth-store.js";
import type { SessionRecord } from "./auth-store.js";
import {
  loginOptions,
  loginVerify,
  passkeySummaries,
  registerOptions,
  registerVerify,
} from "./passkeys.js";
import type { Party } from "./passkeys.js";

const COOKIE = "tw_auth";

/** Where the login form posts. */
const LOGIN_PATH = "/login";
/** Where "Sign out" posts. */
const LOGOUT_PATH = "/logout";
/** The passkey sign-in ceremony: open to anyone, but only through Cloudflare. */
const PASSKEY_LOGIN_OPTIONS = "/auth/passkey/login/options";
const PASSKEY_LOGIN_VERIFY = "/auth/passkey/login/verify";

/** The largest body any of the JSON endpoints here reads. */
const JSON_BODY_LIMIT = 16 * 1024;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    // A malformed value (`%E0`) makes decodeURIComponent throw. Some other
    // site's cookie on the same host is enough to send one, and a throw here
    // used to take the request down with a 500 — or, in the WebSocket upgrade,
    // escape the listener entirely. Skip that cookie and keep the rest.
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* not ours to fix */
    }
  }
  return out;
}

/** Constant-time compare; false on any length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * True if the request arrived through Cloudflare. The sign-in gate applies ONLY
 * to these requests, so direct/tailnet access (e.g. http://<tailscale-ip>:8090)
 * stays open with no token. Cloudflare's edge always stamps cf-ray /
 * cf-connecting-ip; a forged header from a direct client only makes auth stricter
 * (it would then demand a sign-in), never weaker — and a real tunnel request can
 * never lack them.
 */
function viaCloudflare(req: http.IncomingMessage): boolean {
  return Boolean(req.headers["cf-ray"] ?? req.headers["cf-connecting-ip"]);
}

/** What the request's cookie signs it in as, if anything. */
type CookieAuth =
  | { kind: "session"; id: string; record: SessionRecord }
  | { kind: "legacy" }
  | null;

function cookieAuth(req: http.IncomingMessage, token: string): CookieAuth {
  const got = parseCookies(req.headers.cookie)[COOKIE];
  if (typeof got !== "string" || !got) return null;
  const record = lookupSession(got);
  if (record) return { kind: "session", id: got, record };
  // From before sessions: the cookie held the token itself.
  if (token && safeEqual(got, token)) return { kind: "legacy" };
  return null;
}

const NO_TOKEN_MESSAGE =
  "terminal-web: this server has no AUTH_TOKEN set, so access through the " +
  "public tunnel is refused. Set AUTH_TOKEN on the server and restart it.\n";

/**
 * Why a WebSocket upgrade must be refused on auth grounds, as a status line, or
 * null to let it through. Direct/tailnet: always through. Through Cloudflare:
 * 403 with no token configured (fail closed), 401 without a valid cookie.
 */
export function refuseUpgrade(req: http.IncomingMessage, token: string): string | null {
  if (!viaCloudflare(req)) return null;
  if (!token) return "403 Forbidden";
  return cookieAuth(req, token) ? null : "401 Unauthorized";
}

function reqIsHttps(req: http.IncomingMessage): boolean {
  const xf = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(xf) ? xf[0] : xf) ?? "";
  // Behind a tunnel/proxy the edge sets X-Forwarded-Proto; only then is it safe
  // to mark the cookie Secure (a Secure cookie wouldn't work over plain-HTTP
  // tailnet access).
  return proto.split(",")[0]?.trim() === "https";
}

function cookieHeader(value: string, maxAge: number, secure: boolean): string {
  const attrs = [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Set-Cookie for a new session (the id is base64url, so it needs no encoding). */
function sessionCookie(id: string, req: http.IncomingMessage): string {
  return cookieHeader(id, 31536000, reqIsHttps(req));
}

function clearedCookie(req: http.IncomingMessage): string {
  return cookieHeader("", 0, reqIsHttps(req));
}

/** Sign in with the token: a new token session, as a Set-Cookie. */
function tokenSessionCookie(req: http.IncomingMessage): string {
  return sessionCookie(issueSession({ method: "token" }), req);
}

// The login page's script: the passkey button. Plain ES2017 in a string, since
// this page is served for every path to a visitor without a cookie and so can't
// load the app's bundle. The button stays hidden without script or without
// WebAuthn, leaving the token form, which works either way.
//
// Options are fetched ahead of the tap: Safari wants navigator.credentials.get
// called from the tap itself, and a network round-trip in between can use up
// that permission. A fetched challenge is used once, and re-fetched when it is
// older than four minutes (they live for five).
const LOGIN_SCRIPT = `
(function () {
  var box = document.getElementById('pk');
  var btn = document.getElementById('pk-btn');
  var msg = document.getElementById('pk-msg');
  if (!box || !btn || !msg || !window.PublicKeyCredential || !window.isSecureContext) return;
  box.hidden = false;
  function toBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function toB64u(buf) {
    var u = new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function show(text) { msg.textContent = text; msg.hidden = false; }
  function post(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }
  var ready = null, readyAt = 0;
  function prefetch() {
    readyAt = Date.now();
    ready = post('${PASSKEY_LOGIN_OPTIONS}').catch(function () { return { ok: false, body: null }; });
  }
  prefetch();
  btn.addEventListener('click', async function () {
    if (btn.disabled) return;
    btn.disabled = true;
    msg.hidden = true;
    try {
      if (!ready || Date.now() - readyAt > 240000) prefetch();
      var o = await ready;
      ready = null;
      if (!o.ok || !o.body || !o.body.options) { show('Passkey sign-in is not available right now. Use the token.'); return; }
      var opt = o.body.options;
      var cred;
      try {
        cred = await navigator.credentials.get({ publicKey: {
          challenge: toBuf(opt.challenge),
          rpId: opt.rpId,
          timeout: opt.timeout,
          userVerification: opt.userVerification,
          allowCredentials: (opt.allowCredentials || []).map(function (c) {
            return { type: 'public-key', id: toBuf(c.id), transports: c.transports };
          })
        } });
      } catch (e) {
        show(e && e.name === 'NotAllowedError'
          ? 'No passkey was used. If this site has none yet, sign in with the token.'
          : 'Passkey sign-in failed (' + ((e && e.name) || 'error') + '). Use the token.');
        return;
      }
      if (!cred) { show('No passkey was used. Use the token.'); return; }
      var r = cred.response;
      var v = await post('${PASSKEY_LOGIN_VERIFY}', {
        challengeId: o.body.challengeId,
        response: {
          id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
          authenticatorAttachment: cred.authenticatorAttachment || undefined,
          clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
          response: {
            clientDataJSON: toB64u(r.clientDataJSON),
            authenticatorData: toB64u(r.authenticatorData),
            signature: toB64u(r.signature),
            userHandle: r.userHandle ? toB64u(r.userHandle) : undefined
          }
        }
      });
      if (v.ok) {
        if (location.pathname === '${LOGIN_PATH}') location.replace('/'); else location.reload();
        return;
      }
      show((v.body && v.body.error ? v.body.error : 'That passkey was not accepted.') + ' Use the token.');
    } catch (e) {
      show('Passkey sign-in failed. Use the token.');
    } finally {
      btn.disabled = false;
      if (!ready) prefetch();
    }
  });
})();
`;

function loginPage(error: string): string {
  const err = error
    ? `<p class="err">${error.replace(/[<>&]/g, "")}</p>`
    : "";
  // The token is a plain form POST and needs no script: it travels in the
  // body, so it stays out of the address bar, the history and Cloudflare's
  // request logs, which a `?token=` URL did not.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>terminal-web — sign in</title>
<style>
  :root { color-scheme: dark; }
  [hidden] { display:none !important; }
  html,body { height:100%; margin:0; background:#1e1e1e; color:#d4d4d4;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box; }
  .card { width:min(92vw,340px); background:#252526; border:1px solid #3a3a3a; border-radius:12px;
    padding:22px; box-shadow:0 8px 30px rgba(0,0,0,.5); box-sizing:border-box; }
  h1 { font-size:15px; margin:0 0 14px; color:#fff; }
  input { width:100%; box-sizing:border-box; background:#1e1e1e; color:#d4d4d4;
    border:1px solid #3a3a3a; border-radius:8px; padding:12px; font:inherit; font-size:15px; }
  button { width:100%; margin-top:12px; padding:12px; background:#2472c8; color:#fff;
    border:1px solid #3b8eea; border-radius:8px; font:inherit; font-size:15px; cursor:pointer; }
  button:active { background:#2069b8; }
  button:disabled { opacity:.6; cursor:default; }
  #pk-btn { margin-top:0; }
  .or { text-align:center; font-size:12px; color:#8a8a8a; margin:14px 0 12px; }
  .err { color:#f14c4c; font-size:13px; margin:10px 0 0; }
</style></head>
<body><div class="wrap">
  <div class="card">
    <h1>terminal-web</h1>
    <div id="pk" hidden>
      <button id="pk-btn" type="button">Sign in with passkey</button>
      <p id="pk-msg" class="err" role="alert" hidden></p>
      <div class="or">or</div>
    </div>
    <form method="post" action="${LOGIN_PATH}" autocomplete="off">
      <input name="token" type="password" placeholder="Access token" autofocus required
        autocapitalize="off" autocomplete="current-password" spellcheck="false" />
      <button type="submit">Enter</button>
      ${err}
    </form>
  </div>
</div>
<script>${LOGIN_SCRIPT}</script>
</body></html>`;
}

function sendLoginPage(res: http.ServerResponse, error: string): void {
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end(loginPage(error));
}

/** The `token` field of a small form-urlencoded body, or null. */
async function readLoginToken(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 4096) return null; // a token is not this long
    chunks.push(buf);
  }
  const token = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token");
  return token === null ? null : token.trim();
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/**
 * Read a JSON body of at most JSON_BODY_LIMIT bytes. An empty body reads as
 * `{}`. Never throws: too big is a 413, anything unparsable a 400.
 */
async function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > JSON_BODY_LIMIT) return { ok: false, status: 413, error: "Body too large." };
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, error: "Bad request." };
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "Bad request." };
  }
}

/**
 * The relying party a request speaks to: its hostname as the RP ID, and the
 * origin the browser will put in its signed client data. Null when the Host
 * can't be one (missing, an IP address, odd characters).
 *
 * The scheme comes from X-Forwarded-Proto, as for the cookie's Secure flag:
 * https behind the tunnel, http otherwise — which a browser only allows for
 * localhost, so it is there for local tests.
 */
function partyOf(req: http.IncomingMessage): Party | null {
  const host = headerValue(req.headers.host);
  if (!host || /[@/?#\\\s]/.test(host)) return null;
  const { name, bracketed } = hostnameOf(host);
  if (bracketed || net.isIPv4(name)) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name)) return null;
  try {
    const origin = new URL(`${reqIsHttps(req) ? "https" : "http"}://${host.trim().toLowerCase()}`).origin;
    return { rpId: name, origin };
  } catch {
    return null;
  }
}

/** POST /auth/passkey/login/{options,verify}, through Cloudflare, no cookie needed. */
async function handlePasskeyLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }
  const party = partyOf(req);
  if (!party) {
    sendJson(res, 400, { error: "Passkeys need a hostname." });
    return;
  }
  if (pathname === PASSKEY_LOGIN_OPTIONS) {
    sendJson(res, 200, await loginOptions(party));
    return;
  }
  const outcome = await loginVerify(party, body.value);
  if (!outcome.ok) {
    sendJson(res, outcome.status, { error: outcome.error });
    return;
  }
  const id = issueSession({ method: "passkey", credentialId: outcome.value });
  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(id, req) });
}

/**
 * Gate an HTTP request. Resolves true when it fully handled the response
 * (refusal, login page, a sign-in or sign-out, the passkey sign-in endpoints)
 * and the caller should stop; false when the request should proceed normally.
 */
export async function gateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const isLogin = method === "POST" && url.pathname === LOGIN_PATH;
  const isLogout = method === "POST" && url.pathname === LOGOUT_PATH;
  const isPasskeyLogin =
    method === "POST" &&
    (url.pathname === PASSKEY_LOGIN_OPTIONS || url.pathname === PASSKEY_LOGIN_VERIFY);

  if (!viaCloudflare(req)) {
    // Open by design. A stray login or logout POST just goes home; passkeys
    // don't exist here (a tailnet IP can't hold one).
    if (isLogin || isLogout) {
      res.writeHead(303, { Location: "/" });
      res.end();
      return true;
    }
    if (isPasskeyLogin) {
      sendJson(res, 404, { error: "Not found." });
      return true;
    }
    return false;
  }

  // Through the tunnel with no token configured: refuse rather than let the
  // whole internet into a shell — whatever cookie the request carries.
  if (!token) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(NO_TOKEN_MESSAGE);
    return true;
  }

  if (isLogin) {
    const supplied = await readLoginToken(req);
    if (supplied && safeEqual(supplied, token)) {
      // 303 so the browser follows with a GET, and a reload of the page it
      // lands on doesn't offer to resubmit the token.
      res.writeHead(303, {
        "Set-Cookie": tokenSessionCookie(req),
        Location: "/",
      });
      res.end();
      return true;
    }
    sendLoginPage(res, "Wrong token.");
    return true;
  }

  if (isPasskeyLogin) {
    await handlePasskeyLogin(req, res, url.pathname);
    return true;
  }

  if (isLogout) {
    const auth = cookieAuth(req, token);
    if (auth?.kind === "session") {
      revokeSession(auth.id);
      console.log(`[auth] signed out (${auth.record.method} session)`);
    }
    res.writeHead(303, { "Set-Cookie": clearedCookie(req), Location: "/" });
    res.end();
    return true;
  }

  const auth = cookieAuth(req, token);

  // Old bookmarks and launchers carry the token in the URL. Still honoured on
  // a GET, then dropped from the URL straight away. A visitor who is already
  // signed in keeps their session whatever the URL says: a launcher still
  // holding a rotated-out token used to put up the login page on every open,
  // and a correct one minted a new session each time.
  const supplied = url.searchParams.get("token");
  if (supplied !== null && (method === "GET" || method === "HEAD")) {
    const good = safeEqual(supplied, token);
    if (!good && !auth) {
      sendLoginPage(res, "Wrong token.");
      return true;
    }
    url.searchParams.delete("token");
    const qs = url.searchParams.toString();
    const headers: Record<string, string> = { Location: url.pathname + (qs ? `?${qs}` : "") };
    if (!auth || auth.kind === "legacy") headers["Set-Cookie"] = tokenSessionCookie(req);
    res.writeHead(302, headers);
    res.end();
    return true;
  }

  if (auth) {
    // A cookie that holds the token itself: let it through, and swap it for a
    // session on this same response (setHeader survives the writeHead the
    // route makes later).
    if (auth.kind === "legacy") res.setHeader("Set-Cookie", tokenSessionCookie(req));
    return false; // signed in
  }

  sendLoginPage(res, "");
  return true;
}

/**
 * The sign-in API for the app (its Passkeys panel), past the gate:
 *
 *   GET  /api/auth                     how this request is signed in
 *   GET  /api/passkeys                 the registered passkeys (no keys)
 *   POST /api/passkeys/delete          {id}: remove one, and its sessions
 *   POST /api/passkeys/register/options
 *   POST /api/passkeys/register/verify {challengeId, response, name?}
 *
 * Listing and deleting work over the tailnet too (the way back in when a
 * passkey is lost); registering only through Cloudflare. Resolves true when it
 * answered the request.
 */
export async function handleAuthApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const p = url.pathname;
  const cf = viaCloudflare(req);

  if (method === "GET" && p === "/api/auth") {
    const auth = cookieAuth(req, token);
    sendJson(res, 200, {
      viaCloudflare: cf,
      method: auth ? (auth.kind === "legacy" ? "legacy" : auth.record.method) : null,
      passkeyCapable: cf,
    });
    return true;
  }

  if (method === "GET" && p === "/api/passkeys") {
    sendJson(res, 200, passkeySummaries());
    return true;
  }

  if (method === "POST" && p === "/api/passkeys/delete") {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    const id = (body.value as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,1366}$/.test(id)) {
      sendJson(res, 400, { error: "Bad id." });
      return true;
    }
    if (!removePasskey(id)) {
      sendJson(res, 404, { error: "No such passkey." });
      return true;
    }
    console.log(`[auth] passkey deleted (${id.slice(0, 8)}…)`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const isRegister =
    method === "POST" &&
    (p === "/api/passkeys/register/options" || p === "/api/passkeys/register/verify");
  if (!isRegister) return false;

  if (!cf) {
    sendJson(res, 404, { error: "Passkeys can only be added through the https address." });
    return true;
  }
  // The gate already let only signed-in requests this far; checked again
  // because registering is the one thing here that adds a way in.
  if (!token || !cookieAuth(req, token)) {
    sendJson(res, 401, { error: "Sign in first." });
    return true;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return true;
  }
  const party = partyOf(req);
  if (!party) {
    sendJson(res, 400, { error: "Passkeys need a hostname." });
    return true;
  }
  if (p === "/api/passkeys/register/options") {
    const outcome = await registerOptions(party);
    if (outcome.ok) sendJson(res, 200, outcome.value);
    else sendJson(res, outcome.status, { error: outcome.error });
    return true;
  }
  const outcome = await registerVerify(party, body.value, headerValue(req.headers["user-agent"]));
  if (outcome.ok) sendJson(res, 200, outcome.value);
  else sendJson(res, outcome.status, { error: outcome.error });
  return true;
}

// ---------------------------------------------------------------------------
// Host and Origin.
//
// Tailnet access needs no token, so on the tailnet the browser itself is the
// only thing between a web page and a shell. Two ways a page could get one:
//
//   * Cross-site requests. Any page open in a browser on the tailnet can POST
//     to http://100.x:8090/api/sessions/kill, or open ws://100.x:8090/ws and
//     type into a terminal — a WebSocket isn't covered by CORS at all. The
//     browser does say where such a request came from, in Origin, so a
//     state-changing request or an upgrade whose Origin isn't this server is
//     refused.
//   * DNS rebinding. A page on evil.example re-points its own name at
//     100.x, and from then on its requests ARE same-origin as far as the
//     browser can tell — but they carry `Host: evil.example`. So a dotted Host
//     that isn't an IP, localhost, a tailnet name, or listed in ALLOWED_HOSTS
//     is refused.
//
// Cloudflare-fronted requests skip the Host check: the token covers them, and
// their Host is always the tunnel's real hostname. No CORS headers are sent;
// the iframe the launcher embeds makes same-origin requests of its own.
// ---------------------------------------------------------------------------

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The hostname in a Host header, lower-cased, without port or brackets. */
function hostnameOf(host: string): { name: string; bracketed: boolean } {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return { name: end < 0 ? h.slice(1) : h.slice(1, end), bracketed: true };
  }
  const colon = h.lastIndexOf(":");
  return { name: (colon < 0 ? h : h.slice(0, colon)).replace(/\.$/, ""), bracketed: false };
}

/** Whether a request's Host may reach this server (see above). */
export function hostAllowed(req: http.IncomingMessage, allowedHosts: string[]): boolean {
  if (viaCloudflare(req)) return true;
  const host = headerValue(req.headers.host);
  // No Host at all is not a browser, and so not a rebinding page.
  if (!host) return true;
  const { name, bracketed } = hostnameOf(host);
  if (bracketed) return net.isIPv6(name);
  if (net.isIPv4(name)) return true;
  // Anything past this point must at least look like a hostname, so an odd
  // Host (an unbracketed IPv6, userinfo, a path) can't slip through as a
  // "single label" below.
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name)) return false;
  // A single label — `localhost`, a MagicDNS short name like `afei-company-nuc`
  // — can't be registered by anyone else, so it can't be rebound.
  if (!name.includes(".")) return true;
  if (name.endsWith(".ts.net")) return true;
  return allowedHosts.includes(name);
}

/**
 * Whether a request's Origin, if it sent one, is this server. A missing Origin
 * is fine — curl and scripts don't send one, and a browser always does on the
 * requests this guards. `Origin: null` (sandboxed frames, file://, some
 * redirects) can't be told apart from an attacker, so it is refused.
 *
 * Same-origin is judged on host:port against the Host header, not the scheme:
 * behind the tunnel the browser speaks https to Cloudflare and Cloudflare
 * speaks http to us, so the schemes never match.
 */
export function originAllowed(req: http.IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === undefined) return true;
  const host = headerValue(req.headers.host);
  if (!host || origin === "null") return false;
  // Host goes into a URL below; anything that would parse as userinfo, a path
  // or a query there could make two different hosts compare equal.
  if (/[@/?#\\\s]/.test(host)) return false;
  try {
    const o = new URL(origin);
    // Parsed with the Origin's scheme so a default port written out on one
    // side (`Host: x:443`) and left off the other compares equal.
    const h = new URL(`${o.protocol}//${host}`);
    return o.host === h.host;
  } catch {
    return false;
  }
}
