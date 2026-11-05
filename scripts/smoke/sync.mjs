// Headless-Chrome check of the cross-device tab sync, driven over the Chrome
// DevTools Protocol. Run it through run-smoke.sh --sync, which starts a
// scratch server and a headless Chrome and cleans both up.
//
// Usage: node sync.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket>
//
// Each "device" is a page in its own browser context, so each has its own
// localStorage and sessionStorage. Every tmux call here is
// `env -u TMUX -u TMUX_PANE tmux -L <socket> ...`, so it can only reach the
// scratch tmux server run-smoke.sh set up.
//
//   1. A and B load; A opens two tabs; B shows the same tabs in A's order.
//   2. B is frozen (a page left alone); A closes one tab and opens another;
//      B, woken, shows exactly A's tabs in A's order after one sync.
//   3. A session made straight in tmux (no tab tag) sits in a new page C's
//      cached tab list; loading C does not make it a tab anywhere.
//   4. /api/sessions answered out of order (intercepted): the strip follows,
//      "+" stays last, the open tab stays open; an unchanged order leaves the
//      strip's DOM alone.
//   5. /api/sessions hanging (intercepted): the sync gives up and the next one
//      still works.
//   6. /api/sessions reporting another build (intercepted): a visible page
//      says so and waits, reloads when hidden, and reloads only once per
//      build; a hidden page reloads at once.
//
// The checks that a new tab goes last on every device need the server to keep
// the tab order (task S2). Against a server whose /api/sessions has no `build`
// field (before S2) they print XFAIL instead of failing. (They can pass there
// anyway when tmux happens to list sessions in creation order; (4) is what
// checks that the strip follows whatever order the server gives.)
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import path from 'node:path';

const [repoDir, cdpPort, baseUrl, sock] = process.argv.slice(2);
if (!repoDir || !cdpPort || !baseUrl || !sock) {
  console.error('usage: node sync.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket>');
  process.exit(2);
}
const require = createRequire(path.join(repoDir, 'package.json'));
const WebSocket = require('ws');

// Session names this test creates (run-smoke.sh's EXPECTED_SESSIONS for
// --sync). Creation order sync-a, sync-c, sync-b, then sync-aa, is not
// alphabetical, so a server that lists tmux's order fails the S2 checks.
const T_A = 'sync-a';
const T_C = 'sync-c';
const T_B = 'sync-b';
const T_AA = 'sync-aa';
const T_D = 'sync-d';
const HIDDEN = 'sync-hidden';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) =>
  new Promise((resolve) => {
    execFile('env', ['-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-L', sock, ...args], (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout), err: String(stderr) }),
    );
  });
const has = async (name) => (await tmux('has-session', '-t', `=${name}`)).ok;
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
};

// --- CDP: one browser connection, flat sessions per page ---------------------
const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.once('open', r));
let nextId = 1;
const pending = new Map();
const problems = [];
const listeners = new Map(); // sessionId -> fn(method, params)
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.sessionId && listeners.has(msg.sessionId)) listeners.get(msg.sessionId)(msg.method, msg.params);
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

/** A page in a browser context of its own: one "device". */
async function newDevice(label) {
  const { browserContextId } = await cdp('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const dev = {
    label,
    loads: 0,
    // Fetch.requestPaused handler, or null.
    onPaused: null,
    send: (method, params) => cdp(method, params, sessionId),
  };
  listeners.set(sessionId, (method, params) => {
    if (method === 'Page.loadEventFired') dev.loads += 1;
    else if (method === 'Fetch.requestPaused') {
      if (dev.onPaused) dev.onPaused(params);
      else void dev.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      problems.push(`${label} exception: ${d.exception?.description ?? d.text}`);
    } else if (method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(params.type)) {
      problems.push(`${label} console.${params.type}: ${params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
  await dev.send('Runtime.enable');
  await dev.send('Page.enable');
  // Headless Chrome shows only its first window; this makes the others count
  // as on screen (and focused) too, as each device's page would be.
  await dev.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await dev.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  dev.evaluate = async (expr) => {
    const r = await dev.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${label}: evaluate failed: ${r.exceptionDetails.text} :: ${expr}`);
    return r.result.value;
  };
  dev.navigate = async (url) => {
    const before = dev.loads;
    await dev.send('Page.navigate', { url });
    await waitFor(async () => dev.loads > before, 10000);
  };
  // Tab labels in strip order, the open one marked *.
  dev.tabs = () =>
    dev.evaluate(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.querySelector('.tab-label').textContent + (t.classList.contains('active') ? '*' : '')).join(' ')`);
  dev.names = async () => (await dev.tabs()).replace(/\*/g, '');
  // The page's own sync runs on focus (see terminal.ts); this asks for one now.
  dev.sync = () => dev.evaluate(`window.dispatchEvent(new Event('focus'))`);
  // Make the page report itself hidden and tell it so. Undone by a reload.
  dev.hide = () =>
    dev.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
  return dev;
}

/** Open a tab through "+" and the name prompt, as a user would. */
async function addTab(dev, name) {
  await dev.evaluate(`document.querySelector('.tab-add').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))`);
  await waitFor(() => dev.evaluate(`!!document.querySelector('.prompt-overlay')`), 3000);
  await dev.evaluate(`(() => { const i = document.querySelector('.prompt-input'); i.value = ${JSON.stringify(name)}; document.querySelectorAll('.prompt-box .paste-row button')[1].click(); })()`);
  return waitFor(() => has(name));
}

/** Close a tab through its × and the confirm, as a user would. */
async function closeTab(dev, name) {
  const tapped = await dev.evaluate(`(() => {
    const tab = [...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab-label').textContent === ${JSON.stringify(name)});
    if (!tab) return false;
    const x = tab.querySelector('.tab-close');
    const r = x.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, pointerId: 1, clientX: r.left + 2, clientY: r.top + 2 };
    x.dispatchEvent(new PointerEvent('pointerdown', o));
    x.dispatchEvent(new PointerEvent('pointerup', o));
    return true;
  })()`);
  if (!tapped) return false;
  await waitFor(() => dev.evaluate(`!!document.querySelector('.confirm-overlay')`), 3000);
  await dev.evaluate(`document.querySelector('.confirm-overlay .tb-btn.danger').click()`);
  return waitFor(async () => !(await has(name)));
}

/** Answer /api/sessions on `dev` with `edit(json)` applied (null: stop). */
async function interceptSessions(dev, edit) {
  if (!edit) {
    dev.onPaused = null;
    await dev.send('Fetch.disable');
    return;
  }
  dev.onPaused = async (p) => {
    try {
      const r = await dev.send('Fetch.getResponseBody', { requestId: p.requestId });
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      const json = edit(JSON.parse(text));
      await dev.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(JSON.stringify(json)).toString('base64'),
      });
    } catch (err) {
      problems.push(`${dev.label} intercept: ${err.message}`);
      void dev.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
  };
  await dev.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions', requestStage: 'Response' }] });
}

const serverList = async () => {
  const r = await (await fetch(`${baseUrl}/api/sessions`, { cache: 'no-store' })).json();
  return r;
};

const failures = [];
const xfails = [];
let s2 = false; // the server keeps the tab order (has the `build` field)
/** Print a value; with `ok` given, also record a pass or a failure. */
const step = (name, value, ok) => {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  const mark = ok === undefined ? '    ' : ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}: ${shown}`);
  if (ok === false) failures.push(name);
};
/** A check that holds only once the server keeps the tab order (S2). */
const stepS2 = (name, value, ok) => {
  if (s2 || ok) return step(name, value, ok);
  console.log(`XFAIL ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)} (needs S2: server-side tab order)`);
  xfails.push(name);
};

try {
  s2 = typeof (await serverList()).build === 'string';
  step('server', s2 ? 'keeps tab order, reports build' : 'no build field (before S2): order checks may XFAIL');

  // (1) two devices, A opens tabs, B follows
  const A = await newDevice('A');
  await A.navigate(`${baseUrl}/?session=${T_A}`);
  const aUp = await waitFor(() => has(T_A));
  step('1.aAttached', aUp, aUp);
  // B must find A's tab listed, or it would make a fallback tab of its own.
  const aListed = await waitFor(async () => (await serverList()).tabs?.some((t) => t.name === T_A));
  step('1.aListed', aListed, aListed);
  const B = await newDevice('B');
  await B.navigate(`${baseUrl}/`);
  await sleep(1500);
  step('1.bLoaded', await B.tabs(), (await B.names()) === T_A);
  step('1.aAddC', await addTab(A, T_C), await has(T_C));
  await sleep(300);
  step('1.aAddB', await addTab(A, T_B), await has(T_B));
  await sleep(500);
  await A.sync();
  await B.sync();
  const same1 = await waitFor(async () => {
    await B.sync();
    await sleep(300);
    return (await A.names()) === (await B.names());
  });
  step('1.bSameAsA', `A: ${await A.tabs()} | B: ${await B.tabs()}`, same1);
  const aNames1 = await A.names();
  step('1.allThree', aNames1, [T_A, T_B, T_C].every((n) => aNames1.split(' ').includes(n)));
  stepS2('1.creationOrder', aNames1, aNames1 === `${T_A} ${T_C} ${T_B}`);

  // (2) B left alone (frozen), A closes one tab and opens another
  let frozen = true;
  try {
    await B.send('Page.setWebLifecycleState', { state: 'frozen' });
  } catch (err) {
    frozen = false;
    step('2.freeze', `Page.setWebLifecycleState failed (${err.message}); hiding instead`);
    await B.hide();
  }
  step('2.aCloseC', await closeTab(A, T_C), !(await has(T_C)));
  step('2.aAddAA', await addTab(A, T_AA), await has(T_AA));
  await sleep(500);
  await A.sync();
  await sleep(800);
  const aNames2 = await A.names();
  step('2.aTabs', aNames2, !aNames2.split(' ').includes(T_C) && aNames2.split(' ').includes(T_AA));
  if (frozen) await B.send('Page.setWebLifecycleState', { state: 'active' });
  // A sync that was in flight when B froze finishes first, with the list from
  // before; the next one (asked for here, or the 5 s interval) has the answer.
  const woke = Date.now();
  await waitFor(async () => {
    await B.sync();
    await sleep(300);
    return (await B.names()) === aNames2;
  }, 7000);
  step('2.bConvergedIn', `${Date.now() - woke} ms`);
  const bNames2 = await B.names();
  step('2.bNoClosed', bNames2, !bNames2.split(' ').includes(T_C));
  step('2.bHasNew', bNames2, bNames2.split(' ').includes(T_AA));
  step('2.bSameOrderAsA', `A: ${aNames2} | B: ${bNames2}`, aNames2 === bNames2);
  stepS2('2.newGoesLast', bNames2, bNames2 === `${T_A} ${T_B} ${T_AA}`);
  if (!frozen) await B.navigate(`${baseUrl}/`); // drop the visibility override

  // (3) a stale cache does not make a non-tab session a tab
  await tmux('new-session', '-d', '-s', HIDDEN);
  step('3.hiddenMade', await has(HIDDEN), await has(HIDDEN));
  const C = await newDevice('C');
  await C.navigate(`${baseUrl}/api/health`); // same origin, no app: seed storage
  await C.evaluate(`(() => {
    localStorage.setItem('tw.tabs', JSON.stringify([{ name: ${JSON.stringify(HIDDEN)}, displayName: ${JSON.stringify(HIDDEN)} }, { name: ${JSON.stringify(T_A)}, displayName: ${JSON.stringify(T_A)} }]));
    localStorage.setItem('tw.activeTab', ${JSON.stringify(HIDDEN)});
  })()`);
  await C.navigate(`${baseUrl}/`);
  await sleep(2000);
  await C.sync();
  await A.sync();
  await B.sync();
  await sleep(1500);
  const strips = { A: await A.names(), B: await B.names(), C: await C.names() };
  step('3.notInAnyStrip', strips, Object.values(strips).every((t) => !t.split(' ').includes(HIDDEN)));
  step('3.cMatchesServer', strips.C, strips.C === strips.A);
  const tag = (await tmux('show-options', '-v', '-t', `=${HIDDEN}:`, '@twtab')).out.trim();
  step('3.notTagged', JSON.stringify(tag), tag !== '1');
  const listedHidden = (await serverList()).tabs?.some((t) => t.name === HIDDEN);
  step('3.notListed', listedHidden, !listedHidden);

  // (4) the strip follows the server's order, whatever it is
  const before4 = await A.tabs();
  const active4 = before4.split(' ').find((t) => t.endsWith('*'));
  await interceptSessions(A, (json) => ({ ...json, tabs: Array.isArray(json.tabs) ? [...json.tabs].reverse() : json.tabs }));
  await A.sync();
  await sleep(800);
  const reversed = (await serverList()).tabs.map((t) => t.name).reverse().join(' ');
  const after4 = await A.tabs();
  step('4.followsServerOrder', `${before4} -> ${after4} (server reversed: ${reversed})`, after4.replace(/\*/g, '') === reversed);
  step('4.activeKept', after4, after4.split(' ').includes(active4));
  const plusLast = await A.evaluate(`document.querySelector('#tabs').lastElementChild.classList.contains('tab-add')`);
  step('4.plusLast', plusLast, plusLast);
  // Same order again: the strip's DOM is left alone.
  await A.evaluate(`(() => { window.__twMut = 0; new MutationObserver((m) => { window.__twMut += m.length; }).observe(document.querySelector('#tabs'), { childList: true }); })()`);
  await A.sync();
  await sleep(800);
  await A.sync();
  await sleep(800);
  const muts = await A.evaluate('window.__twMut');
  step('4.unchangedOrderNoDomMoves', muts, muts === 0);
  await interceptSessions(A, null);
  await A.sync();
  await sleep(800);
  const back4 = await A.names();
  step('4.backToServerOrder', back4, back4 === (await serverList()).tabs.map((t) => t.name).join(' '));

  // (5) a hanging /api/sessions does not stop later syncs
  B.onPaused = () => {}; // never answered
  await B.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions', requestStage: 'Request' }] });
  await B.sync(); // hangs until the page's own timeout
  step('5.aAddD', await addTab(A, T_D), await has(T_D));
  await sleep(3500); // past fetchServerTabs' 2.5 s
  B.onPaused = null;
  await B.send('Fetch.disable');
  const bGotD = await waitFor(async () => {
    await B.sync();
    await sleep(400);
    return (await B.names()).split(' ').includes(T_D);
  }, 10000);
  step('5.syncRecovers', await B.tabs(), bGotD);

  // (6) another build on the server: reload, once per build
  const D = await newDevice('D');
  await D.navigate(`${baseUrl}/`);
  await sleep(1500);
  await D.send('Page.bringToFront');
  await sleep(300);
  const vis = {};
  for (const dev of [A, B, C, D]) vis[dev.label] = await dev.evaluate('document.visibilityState');
  step('6.visibility', vis, vis.D === 'visible');
  const own = await D.evaluate(`new URL(document.querySelector('script[type="module"][src*="/dist/terminal.js"]').src).searchParams.get('v') ?? ''`);
  step('6.ownBuild', own, own.length > 0);
  const loads0 = D.loads;
  let fake = 'fakebuild-1';
  await interceptSessions(D, (json) => ({ ...json, build: fake }));
  await D.sync();
  await sleep(1000);
  const msg = await D.evaluate(`(() => { const s = document.getElementById('status'); return s && s.classList.contains('visible') ? s.textContent : ''; })()`);
  step('6.visibleSaysSoAndWaits', `${msg} (loads +${D.loads - loads0})`, /new version/i.test(msg) && D.loads === loads0);
  await D.hide();
  const reloaded1 = await waitFor(async () => D.loads > loads0, 5000);
  step('6.reloadsWhenHidden', `loads +${D.loads - loads0}`, reloaded1);
  await sleep(1500);
  await D.hide();
  await D.sync();
  await sleep(1500);
  await D.sync();
  await sleep(1500);
  step('6.onlyOncePerBuild', `loads +${D.loads - loads0}`, D.loads === loads0 + 1);
  // A newer build still, while hidden: at once.
  fake = 'fakebuild-2';
  await D.sync();
  const reloaded2 = await waitFor(async () => D.loads > loads0 + 1, 5000);
  step('6.hiddenReloadsAtOnce', `loads +${D.loads - loads0}`, reloaded2);
  await sleep(1500);
  await D.hide();
  await D.sync();
  await sleep(1500);
  step('6.noLoop', `loads +${D.loads - loads0}`, D.loads === loads0 + 2);
  await interceptSessions(D, null);
} catch (err) {
  step('run', String(err?.stack ?? err), false);
}

step('pageProblems', problems, problems.length === 0);
ws.close();
if (xfails.length) console.log(`\nexpected failures before S2: ${xfails.join(', ')}`);
console.log(failures.length ? `\nSYNC SMOKE FAILED: ${failures.join(', ')}` : '\nSYNC SMOKE PASSED');
process.exit(failures.length ? 1 : 0);
