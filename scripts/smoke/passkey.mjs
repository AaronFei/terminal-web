// Headless-Chrome test of sign-in through "Cloudflare": token sessions,
// passkeys (a CDP virtual authenticator), the legacy cookie, sign-out, and the
// tailnet staying open. Run it through run-smoke.sh --passkey (npm run
// smoke:passkey), which starts a headless Chrome and cleans up; it is not meant
// to be run on its own.
//
// Usage: node passkey.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket> <scratchDir>
//
// Unlike smoke.mjs, this driver runs the scratch server itself, because it has
// to restart it with a different AUTH_TOKEN. The server gets the same
// isolation run-smoke.sh gives it: HOME=<scratchDir>/home,
// TERMINAL_WEB_TMUX_SOCKET=<tmuxSocket>, HOST=127.0.0.1, TMUX/TMUX_PANE and
// the inherited AUTH_TOKEN unset. Its PID goes to <scratchDir>/server.pid so
// run-smoke.sh can stop it if this script dies first. It is stopped by PID,
// never by name.
//
// "Through Cloudflare" is faked with a `cf-ray` header on every request
// (Network.setExtraHTTPHeaders in Chrome, a plain header from Node). The page
// is opened as http://localhost:<port>, which browsers treat as a secure
// context, so WebAuthn runs with the RP ID "localhost".
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [repoDir, cdpPort, baseUrl, sock, scratchDir] = process.argv.slice(2);
if (!repoDir || !cdpPort || !baseUrl || !sock || !scratchDir) {
  console.error('usage: node passkey.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket> <scratchDir>');
  process.exit(2);
}
const require = createRequire(path.join(repoDir, 'package.json'));
const WebSocket = require('ws');

const base = new URL(baseUrl);
const port = base.port;
const home = path.join(scratchDir, 'home');
const dataDir = path.join(home, '.terminal-web');
const SESSIONS_FILE = path.join(dataDir, 'auth-sessions.json');
const PASSKEYS_FILE = path.join(dataDir, 'passkeys.json');
// Test tokens only; whatever AUTH_TOKEN this shell has is unset for the server.
const TOKEN1 = `test-token-one-${crypto.randomBytes(12).toString('hex')}`;
const TOKEN2 = `test-token-two-${crypto.randomBytes(12).toString('hex')}`;
// The tmux sessions this test makes: SESSION by name, and the server's default
// one, which the page opens after signing in with the form (it lands on "/").
// run-smoke.sh kills the scratch tmux server only when these are all it holds.
const SESSION = 'pk-a';
const DEFAULT_SESSION = 'web';
const CF = { 'cf-ray': 'smoke-test' };
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) =>
  new Promise((resolve) => {
    execFile('env', ['-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-L', sock, ...args], (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout), err: String(stderr) }),
    );
  });
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
};

const failures = [];
const step = (name, value, ok) => {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  const mark = ok === undefined ? '    ' : ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}: ${shown}`);
  if (ok === false) failures.push(name);
};

// ---------------------------------------------------------------------------
// The scratch server
// ---------------------------------------------------------------------------
let server = null;

async function startServer(token) {
  const log = fs.openSync(path.join(scratchDir, 'server.log'), 'a');
  const child = spawn(
    'env',
    [
      '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'AUTH_TOKEN', '-u', 'ALLOWED_HOSTS',
      '-u', 'DEFAULT_SESSION', '-u', 'UPLOAD_DIR',
      `HOME=${home}`, `TERMINAL_WEB_TMUX_SOCKET=${sock}`, 'HOST=127.0.0.1', `PORT=${port}`,
      `AUTH_TOKEN=${token}`,
      path.join(repoDir, 'node_modules', '.bin', 'tsx'), 'src/server.ts',
    ],
    { cwd: repoDir, stdio: ['ignore', log, log] },
  );
  fs.closeSync(log);
  const exited = new Promise((r) => child.once('exit', r));
  server = { child, exited };
  fs.writeFileSync(path.join(scratchDir, 'server.pid'), String(child.pid));
  const up = await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 20000);
  if (!up) throw new Error('scratch server did not come up (see server.log with SMOKE_KEEP=1)');
}

const childPids = (pid) =>
  new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (err, stdout) =>
      resolve(err ? [] : String(stdout).split('\n').filter(Boolean).map(Number)),
    );
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopServer() {
  if (!server) return;
  const { child, exited } = server;
  server = null;
  const kids = await childPids(child.pid);
  child.kill('SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
  if (!done) {
    console.log('server did not stop; SIGKILL');
    child.kill('SIGKILL');
    await exited;
  }
  for (const k of kids) if (alive(k)) process.kill(k, 'SIGTERM');
  fs.rmSync(path.join(scratchDir, 'server.pid'), { force: true });
}

// If this script dies with the server still up, at least send it a SIGTERM.
process.on('exit', () => {
  if (server) {
    try {
      server.child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
});

// ---------------------------------------------------------------------------
// HTTP from Node (cookies by hand)
// ---------------------------------------------------------------------------
async function http(pathname, { cf = true, cookie, method = 'GET', body, headers = {} } = {}) {
  const h = { ...(cf ? CF : {}), ...headers };
  if (cookie !== undefined) h.cookie = `tw_auth=${cookie}`;
  let b = body;
  if (body !== undefined && typeof body !== 'string') {
    b = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers: h, body: b, redirect: 'manual' });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const tw = setCookie.map((c) => /^tw_auth=([^;]*)/.exec(c)).find(Boolean);
  return { status: res.status, text, setCookie, cookieValue: tw ? tw[1] : undefined, location: res.headers.get('location') };
}
const isLoginPage = (r) => r.status === 401 && /sign in/.test(r.text);
const isApp = (r) => r.status === 200 && /id="terminal"/.test(r.text);

function wsOpens(cookie, cf = true) {
  return new Promise((resolve) => {
    const headers = { ...(cf ? CF : {}) };
    if (cookie) headers.cookie = `tw_auth=${cookie}`;
    const ws = new WebSocket(`ws://${base.host}/ws?session=${SESSION}&cols=100&rows=30`, { headers });
    const t = setTimeout(() => {
      ws.terminate();
      resolve('timeout');
    }, 5000);
    ws.once('open', () => {
      clearTimeout(t);
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(t);
      resolve(String(res.statusCode));
      ws.terminate();
    });
    ws.once('error', () => {
      clearTimeout(t);
      resolve('error');
    });
  });
}

function fileCheck(label, secrets) {
  for (const f of [SESSIONS_FILE, PASSKEYS_FILE]) {
    const name = path.basename(f);
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      step(`${label}.${name}`, 'missing', false);
      continue;
    }
    const mode = (st.mode & 0o777).toString(8);
    const text = fs.readFileSync(f, 'utf8');
    const leaked = secrets.filter((s) => s && text.includes(s)).length;
    step(`${label}.${name}`, `mode ${mode}, ${leaked} secret(s) found in it`, mode === '600' && leaked === 0);
  }
  const dmode = (fs.statSync(dataDir).mode & 0o777).toString(8);
  step(`${label}.dirMode`, dmode, dmode === '700');
}

// ---------------------------------------------------------------------------
// Chrome over CDP
// ---------------------------------------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target in headless Chrome');
  process.exit(2);
}
const cdp = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => cdp.once('open', r));
let nextId = 1;
const pending = new Map();
const problems = [];
cdp.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    problems.push(`exception: ${d.exception?.description ?? d.text}`);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const { text, url = '' } = msg.params.entry;
    // Expected here: 401s are the point (login page, refused passkeys), the
    // 400/413 come from the malformed-body checks, and the browser fetches the
    // web manifest without cookies, so behind the sign-in it always gets a 401.
    const expected =
      /status of 401/.test(text) ||
      (/status of (400|413)/.test(text) && url.includes('/auth/passkey/login/verify')) ||
      /Manifest fetch .* failed, code 401/.test(text);
    if (!expected) problems.push(`log: ${text} ${url}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    cdp.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const click = async (selector) => {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element ${selector}`);
  const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
};
const navigate = async (url) => {
  await send('Page.navigate', { url });
  await sleep(1500);
};
/** With SMOKE_SHOTS=<dir>, save a PNG of the page there (for looking at the UI). */
const shot = async (name) => {
  if (!process.env.SMOKE_SHOTS) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  fs.writeFileSync(path.join(process.env.SMOKE_SHOTS, `passkey-${name}.png`), Buffer.from(data, 'base64'));
};
const title = () => evaluate('document.title');
const onLoginPage = async () => /sign in/.test(await title());
const browserCookie = async () =>
  (await send('Network.getCookies', { urls: [baseUrl] })).cookies.find((c) => c.name === 'tw_auth');
const tabConnected = () =>
  waitFor(() => evaluate(`!!document.querySelector('#tabs .tab.active .tab-dot.connected')`), 10000);
const pageJson = (p, init) =>
  evaluate(`fetch(${JSON.stringify(p)}, ${JSON.stringify(init ?? { cache: 'no-store' })})
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

// In-page helpers for the challenge tests: one passkey assertion for given
// options, serialised the way the login page does it.
const PAGE_HELPERS = `(() => {
  const toBuf = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  const toB64u = (buf) => { const u = new Uint8Array(buf); let s = ''; for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); };
  window.__post = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  window.__assert = async (opt) => {
    const c = await navigator.credentials.get({ publicKey: { challenge: toBuf(opt.challenge), rpId: opt.rpId,
      userVerification: opt.userVerification, allowCredentials: [] } });
    const r = c.response;
    return { id: c.id, rawId: toB64u(c.rawId), type: c.type, clientExtensionResults: {},
      response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData),
        signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : undefined } };
  };
  return true;
})()`;

const secrets = [TOKEN1, TOKEN2];
let exitCode = 1;
try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setExtraHTTPHeaders', { headers: CF });
  await send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await startServer(TOKEN1);
  step('server', `up with token 1 on ${baseUrl}`);

  // (a) no cookie through "Cloudflare": the login page, with the passkey button
  await navigate(`${baseUrl}/?session=${SESSION}`);
  step('a.loginPage', await title(), await onLoginPage());
  const pkShown = await evaluate(`!document.getElementById('pk').hidden`);
  step('a.passkeyButtonShown', pkShown, pkShown);
  await shot('login');

  // (b) token sign-in through the form
  await evaluate(`(() => { document.querySelector('input[name=token]').value = ${JSON.stringify(TOKEN1)};
    document.querySelector('form button[type=submit]').click(); return true; })()`);
  await waitFor(async () => !(await onLoginPage()), 8000);
  await sleep(1000);
  step('b.appAfterToken', await title(), !(await onLoginPage()));
  const c1 = await browserCookie();
  const tokenSession = c1?.value;
  secrets.push(tokenSession);
  step(
    'b.cookieIsSessionNotToken',
    c1 ? `len ${c1.value.length}, httpOnly ${c1.httpOnly}, sameSite ${c1.sameSite}` : 'none',
    !!c1 && c1.value !== TOKEN1 && SESSION_ID_RE.test(c1.value) && c1.httpOnly,
  );
  // POST /login lands on "/", which opens the default session.
  const sExists = await waitFor(async () => (await tmux('has-session', '-t', `=${DEFAULT_SESSION}`)).ok);
  const attached1 = sExists && (await tabConnected());
  step('b.terminalAttached', attached1, attached1);
  const auth1 = await pageJson('/api/auth');
  step('b.apiAuth', auth1.body, auth1.body?.method === 'token' && auth1.body?.viaCloudflare === true);

  // (c) add a passkey from the app: ? -> Passkeys -> Add a passkey
  await evaluate(`(() => { const b = [...document.querySelectorAll('#controls button')].find((x) => x.textContent === '?');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); return true; })()`);
  await sleep(300);
  await click('[data-help-passkeys]');
  const addReady = await waitFor(() => evaluate(`!!document.querySelector('.pk-add-btn') && !document.querySelector('.pk-add-btn').disabled`));
  step('c.addEnabled', addReady, addReady);
  await evaluate(`(() => { document.querySelector('.pk-name').value = 'smoke key'; return true; })()`);
  await sleep(300); // the options prefetch
  await click('.pk-add-btn');
  const listed = await waitFor(() => evaluate(`[...document.querySelectorAll('.pk-item-name')].some((n) => n.textContent === 'smoke key')`));
  step('c.listedInPanel', await evaluate(`document.querySelector('.pk-list').innerText.replace(/\\n/g, ' | ')`), listed);
  const creds = (await send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  step('c.authenticatorHasResidentKey', `${creds.length} credential(s), resident ${creds[0]?.isResidentCredential}, rp ${creds[0]?.rpId}`,
    creds.length === 1 && creds[0].isResidentCredential && creds[0].rpId === 'localhost');
  const signOutShown = await evaluate(`!document.querySelector('.pk-signout').hidden`);
  step('c.signOutShown', signOutShown, signOutShown);
  await shot('panel');

  // (d) cookies gone: sign in with the passkey from the login page
  await send('Network.clearBrowserCookies');
  await navigate(`${baseUrl}/?session=${SESSION}`);
  step('d.loginPageAgain', await title(), await onLoginPage());
  await sleep(500); // the options prefetch
  await click('#pk-btn');
  await waitFor(async () => !(await onLoginPage()), 8000);
  await sleep(1000);
  step('d.appAfterPasskey', await title(), !(await onLoginPage()));
  const c2 = await browserCookie();
  const passkeySession = c2?.value;
  secrets.push(passkeySession);
  step('d.newSessionCookie', c2 ? `len ${c2.value.length}` : 'none',
    !!c2 && SESSION_ID_RE.test(c2.value) && c2.value !== tokenSession && c2.value !== TOKEN1);
  const auth2 = await pageJson('/api/auth');
  step('d.apiAuth', auth2.body, auth2.body?.method === 'passkey');
  const attached2 = await tabConnected();
  step('d.terminalAttached', attached2, attached2);
  const wsPk = await wsOpens(passkeySession);
  step('d.wsWithPasskeySession', wsPk, wsPk === 'open');
  const wsNone = await wsOpens(undefined);
  step('d.wsWithoutCookie', wsNone, wsNone === '401');

  // (e) the list
  const list = await pageJson('/api/passkeys');
  const item = Array.isArray(list.body) ? list.body[0] : null;
  step('e.apiPasskeys', list.body,
    Array.isArray(list.body) && list.body.length === 1 && item.name === 'smoke key' && item.rpId === 'localhost' &&
      !('publicKey' in item) && item.lastUsedAt !== null);
  const credId = item?.id;

  // (f) challenges are single-use
  await evaluate(PAGE_HELPERS);
  const replay = await evaluate(`(async () => {
    const o = await __post('/auth/passkey/login/options', {});
    const resp = await __assert(o.body.options);
    const first = await __post('/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: resp });
    const again = await __post('/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: resp });
    return [first.status, again.status];
  })()`);
  step('f.verifyThenReplay', replay, replay[0] === 200 && replay[1] === 401);
  const spent = await evaluate(`(async () => {
    const o = await __post('/auth/passkey/login/options', {});
    const junk = await __post('/auth/passkey/login/verify', { challengeId: o.body.challengeId,
      response: { id: 'AAAA', response: { clientDataJSON: 'e30' } } });
    const resp = await __assert(o.body.options);
    const real = await __post('/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: resp });
    return [junk.status, real.status];
  })()`);
  step('f.challengeSpentByFailedAttempt', spent, spent[0] === 401 && spent[1] === 401);
  const crossKind = await evaluate(`(async () => {
    const o = await __post('/api/passkeys/register/options', {});
    const resp = await __assert({ challenge: o.body.options.challenge, rpId: 'localhost', userVerification: 'preferred' });
    return (await __post('/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: resp })).status;
  })()`);
  step('f.registerChallengeCantSignIn', crossKind, crossKind === 401);
  const malformed = await evaluate(`(async () => [
    (await __post('/auth/passkey/login/verify', 'nope')).status,
    (await fetch('/auth/passkey/login/verify', { method: 'POST', body: '{bad json' })).status,
    (await fetch('/auth/passkey/login/verify', { method: 'POST', body: 'x'.repeat(20000) })).status,
  ])()`);
  step('f.malformedBodies', malformed, malformed[0] === 400 && malformed[1] === 400 && malformed[2] === 413);

  // (g) the legacy cookie (= the token) still works, and is swapped for a session
  const legacy = await http('/', { cookie: TOKEN1 });
  step('g.legacyCookieAccepted', `${legacy.status}, new cookie ${legacy.cookieValue ? `len ${legacy.cookieValue.length}` : 'none'}`,
    isApp(legacy) && !!legacy.cookieValue && SESSION_ID_RE.test(legacy.cookieValue) && legacy.cookieValue !== TOKEN1);
  secrets.push(legacy.cookieValue);
  const swapped = await http('/', { cookie: legacy.cookieValue });
  step('g.swappedCookieWorks', swapped.status, isApp(swapped));
  const legacyWs = await wsOpens(TOKEN1);
  step('g.legacyCookieWs', legacyWs, legacyWs === 'open');
  const wrong = await http('/', { cookie: 'x'.repeat(43) });
  step('g.unknownCookie', wrong.status, isLoginPage(wrong));

  // (h) sign-in by POST /login and sign-out
  const login = await http('/login', { method: 'POST', body: `token=${encodeURIComponent(TOKEN1)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  secrets.push(login.cookieValue);
  step('h.loginPost', `${login.status}, cookie ${login.cookieValue ? 'set' : 'none'}`, login.status === 303 && SESSION_ID_RE.test(login.cookieValue ?? ''));
  const before = await http('/', { cookie: login.cookieValue });
  const logout = await http('/logout', { method: 'POST', cookie: login.cookieValue });
  const after = await http('/', { cookie: login.cookieValue });
  step('h.logout', `${before.status} -> logout ${logout.status} (${logout.setCookie[0]?.includes('Max-Age=0') ? 'cleared' : 'not cleared'}) -> ${after.status}`,
    isApp(before) && logout.status === 303 && logout.setCookie[0]?.includes('Max-Age=0') && isLoginPage(after));
  const oldToken = await http('/?token=' + encodeURIComponent(TOKEN1));
  secrets.push(oldToken.cookieValue);
  step('h.tokenInUrl', `${oldToken.status} -> ${oldToken.text.length ? 'body' : 'no body'}, cookie ${oldToken.cookieValue ? 'session' : 'none'}`,
    oldToken.status === 302 && SESSION_ID_RE.test(oldToken.cookieValue ?? '') && oldToken.cookieValue !== TOKEN1);
  // A launcher's URL token with a session already in place: a stale token
  // doesn't put up the login page, a right one doesn't mint another session,
  // and a stale one without a session still does.
  const stale = await http('/?session=x&token=stale', { cookie: oldToken.cookieValue });
  step('h.staleUrlTokenWithSession', `${stale.status} -> ${stale.location ?? '?'}, cookie ${stale.cookieValue ? 'new' : 'kept'}`,
    stale.status === 302 && !stale.cookieValue && (stale.location ?? '') === '/?session=x');
  const again = await http('/?token=' + encodeURIComponent(TOKEN1), { cookie: oldToken.cookieValue });
  step('h.rightUrlTokenWithSession', `${again.status}, cookie ${again.cookieValue ? 'new' : 'kept'}`,
    again.status === 302 && !again.cookieValue);
  const staleNoSession = await http('/?token=stale');
  step('h.staleUrlTokenNoSession', staleNoSession.status, isLoginPage(staleNoSession));

  // (i) the tailnet (no cf-ray): no passkey endpoints, the app opens with no cookie
  const tn = [
    await http('/auth/passkey/login/options', { cf: false, method: 'POST', body: {} }),
    await http('/auth/passkey/login/verify', { cf: false, method: 'POST', body: {} }),
    await http('/api/passkeys/register/options', { cf: false, method: 'POST', body: {} }),
    await http('/api/passkeys/register/verify', { cf: false, method: 'POST', body: {} }),
  ].map((r) => r.status);
  step('i.tailnetCeremonies404', tn, tn.every((s) => s === 404));
  const tnApp = await http('/', { cf: false });
  step('i.tailnetAppOpen', tnApp.status, isApp(tnApp));
  const tnList = await http('/api/passkeys', { cf: false });
  step('i.tailnetCanList', tnList.status, tnList.status === 200 && JSON.parse(tnList.text).length === 1);
  const cfNoCookie = await http('/api/passkeys/register/options', { method: 'POST', body: {} });
  step('i.registerNeedsSignIn', cfNoCookie.status, isLoginPage(cfNoCookie));

  await sleep(500); // writes are asynchronous
  fileCheck('j', secrets);

  // (k) restart with another token, and the passkey's RP ID changed on disk
  await stopServer();
  const pkFile = JSON.parse(fs.readFileSync(PASSKEYS_FILE, 'utf8'));
  for (const p of pkFile.passkeys) p.rpId = 'example.com';
  fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(pkFile, null, 2), { mode: 0o600 });
  await startServer(TOKEN2);
  step('server', 'restarted with token 2, passkey moved to rp example.com');
  const deadToken = await http('/', { cookie: tokenSession });
  step('k.tokenSessionDiesWithToken', deadToken.status, isLoginPage(deadToken));
  const deadLegacy = await http('/', { cookie: TOKEN1 });
  step('k.oldLegacyCookieRefused', deadLegacy.status, isLoginPage(deadLegacy));
  const pkAlive = await http('/', { cookie: passkeySession });
  step('k.passkeySessionSurvives', pkAlive.status, isApp(pkAlive));

  await send('Network.clearBrowserCookies');
  await navigate(`${baseUrl}/?session=${SESSION}`);
  await sleep(500);
  await click('#pk-btn');
  const shownErr = await waitFor(() => evaluate(`!document.getElementById('pk-msg').hidden`));
  const errText = await evaluate(`document.getElementById('pk-msg').textContent`);
  step('k.otherRpRefused', errText, shownErr && (await onLoginPage()) && !(await browserCookie()));
  await shot('login-refused');
  await evaluate(`(() => { document.querySelector('input[name=token]').value = ${JSON.stringify(TOKEN2)};
    document.querySelector('form button[type=submit]').click(); return true; })()`);
  await waitFor(async () => !(await onLoginPage()), 8000);
  await sleep(800);
  step('k.tokenFormStillWorks', await title(), !(await onLoginPage()));
  secrets.push((await browserCookie())?.value);

  // (l) delete the passkey: its session is gone with it
  const del = await http('/api/passkeys/delete', { method: 'POST', cookie: passkeySession, body: { id: credId } });
  step('l.delete', del.status, del.status === 200);
  const afterDel = await http('/', { cookie: passkeySession });
  step('l.passkeySessionDead', afterDel.status, isLoginPage(afterDel));
  const emptyList = await http('/api/passkeys', { cf: false });
  step('l.listEmpty', emptyList.text, emptyList.status === 200 && emptyList.text === '[]');
  const delAgain = await http('/api/passkeys/delete', { cf: false, method: 'POST', body: { id: credId } });
  step('l.deleteUnknown', delAgain.status, delAgain.status === 404);

  await sleep(500);
  fileCheck('m', secrets);

  // (n) the tailnet in Chrome: no header, no cookie, straight into the app
  await send('Network.setExtraHTTPHeaders', { headers: {} });
  await send('Network.clearBrowserCookies');
  await navigate(`${baseUrl}/?session=${SESSION}`);
  step('n.tailnetApp', await title(), !(await onLoginPage()));
  const attached3 = await tabConnected();
  step('n.terminalAttached', attached3, attached3);
  const auth3 = await pageJson('/api/auth');
  step('n.apiAuth', auth3.body, auth3.body?.viaCloudflare === false && auth3.body?.passkeyCapable === false);

  // (o) no AUTH_TOKEN at all: everything through "Cloudflare" is refused, the
  // tailnet still opens
  const lastSession = (await http('/login', { method: 'POST', body: `token=${encodeURIComponent(TOKEN2)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' } })).cookieValue;
  secrets.push(lastSession);
  await stopServer();
  await startServer('');
  step('server', 'restarted with no token');
  const noTok = [
    await http('/', { cookie: lastSession }),
    await http('/auth/passkey/login/options', { method: 'POST', body: {} }),
    await http('/login', { method: 'POST', body: `token=${encodeURIComponent(TOKEN2)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
  ].map((r) => r.status);
  step('o.cloudflareRefused', noTok, noTok.every((s) => s === 403));
  const noTokTailnet = await http('/', { cf: false });
  step('o.tailnetStillOpen', noTokTailnet.status, isApp(noTokTailnet));
  const noTokWs = await wsOpens(lastSession);
  step('o.wsRefused', noTokWs, noTokWs === '403');

  exitCode = 0;
} catch (err) {
  step('run', String(err?.stack ?? err), false);
} finally {
  await stopServer().catch((e) => step('stopServer', String(e), false));
}

step('pageProblems', problems, problems.length === 0);
cdp.close();
const failed = exitCode !== 0 || failures.length > 0;
console.log(failed ? `\nPASSKEY SMOKE FAILED: ${failures.join(', ')}` : '\nPASSKEY SMOKE PASSED');
process.exit(failed ? 1 : 0);
