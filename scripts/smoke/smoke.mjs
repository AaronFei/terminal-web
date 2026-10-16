// Headless-Chrome smoke test for terminal-web, driven over the Chrome DevTools
// Protocol. Run it through run-smoke.sh, which starts a scratch server and a
// headless Chrome and cleans both up; it is not meant to be run on its own.
//
// Usage: node smoke.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket>
//
// Every tmux call here is `env -u TMUX -u TMUX_PANE tmux -L <socket> ...`, so
// it can only ever reach the scratch tmux server run-smoke.sh set up.
//
// It loads the page, checks a terminal attaches, types a command and reads it
// back out of tmux, opens a second tab, switches between tabs, opens a split,
// narrows and widens the window, and turns touch select on and off from the ⋯
// sheet. Each check prints one line; the exit code
// is 0 only when every check passed and the page threw nothing.
// SMOKE_VERBOSE=1 also prints an outline of the page's DOM.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import path from 'node:path';

const [repoDir, cdpPort, baseUrl, sock] = process.argv.slice(2);
if (!repoDir || !cdpPort || !baseUrl || !sock) {
  console.error('usage: node smoke.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket>');
  process.exit(2);
}
// The repo's own `ws` package, so this script needs nothing installed beyond
// the project's dependencies.
const require = createRequire(path.join(repoDir, 'package.json'));
const WebSocket = require('ws');

// Session names this test creates. run-smoke.sh only kills the scratch tmux
// server when these are all it holds.
const A = 'smoke-a';
const B = 'smoke-b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) =>
  new Promise((resolve) => {
    execFile('env', ['-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-L', sock, ...args], (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout), err: String(stderr) }),
    );
  });

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target in headless Chrome');
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.once('open', r));
let nextId = 1;
const pending = new Map();
const problems = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    problems.push(`exception: ${d.exception?.description ?? d.text}`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
    problems.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text} :: ${expr}`);
  return r.result.value;
};
const click = async (selector) => {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element ${selector}`);
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};
const has = async (name) => (await tmux('has-session', '-t', `=${name}`)).ok;
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
};
// The page's DOM, outlined: tag#id.classes for everything outside xterm's own
// subtree, which is renderer internals.
const OUTLINE = `(() => {
  const out = [];
  const walk = (el, depth) => {
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).sort().join('.') : '';
    const txt = el.children.length === 0 && el.textContent ? ' "' + el.textContent.trim().slice(0, 30) + '"' : '';
    const st = el.getAttribute && el.getAttribute('style') ? ' style=' + el.getAttribute('style') : '';
    out.push('  '.repeat(depth) + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + txt + st);
    if (el.classList && el.classList.contains('xterm')) return;
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  return out.join('\\n');
})()`;
const TAB_LIST = `[...document.querySelectorAll('#tabs .tab')].map((t) => t.querySelector('.tab-label').textContent + (t.classList.contains('active') ? '*' : '')).join(' ')`;
const SPLIT_INSETS = `[...document.querySelectorAll('.term-pane.split:not(.hidden)')].map((p) => p.style.inset).join(' / ')`;

const failures = [];
/** Print a value; with `ok` given, also record a pass or a failure. */
const step = (name, value, ok) => {
  const shown = typeof value === 'string' ? value : JSON.stringify(value);
  const mark = ok === undefined ? '    ' : ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}: ${shown}`);
  if (ok === false) failures.push(name);
};

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

  // (a) load
  await send('Page.navigate', { url: `${baseUrl}/?session=${A}` });
  await sleep(2500);
  const title = await evaluate('document.title');
  step('a.title', title, /terminal-web/.test(title));
  step('a.controls', await evaluate(`[...document.querySelectorAll('#controls > *')].map((e) => e.textContent || e.title).join(' ')`));
  const keys = await evaluate(`[...document.querySelectorAll('#keybar > *')].map((e) => e.textContent || '|').join(' ')`);
  step('a.keybarKeys', keys, /Esc/.test(keys) && /\^X\^S/.test(keys));
  step('a.keybarHiddenOnDesktop', await evaluate(`document.getElementById('keybar').classList.contains('hidden')`));

  // (b) attached
  const aExists = await waitFor(() => has(A));
  step('b.sessionExists', aExists, aExists);
  const tabs = await evaluate(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.querySelector('.tab-label').textContent + (t.classList.contains('active') ? '*' : '') + (t.querySelector('.tab-dot.connected') ? '(on)' : '(off)')).join(' ')`);
  step('b.tabs', tabs, tabs.includes(`${A}*(on)`));

  // (c) type a command and read the answer out of tmux
  await click('.term-pane:not(.hidden) .xterm-screen');
  await sleep(300);
  step('c.focus', await evaluate(`document.activeElement?.className ?? ''`));
  await send('Input.insertText', { text: 'echo HI_$((6*7))' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  const sawHi = await waitFor(async () => /^HI_42\s*$/m.test((await tmux('capture-pane', '-p', '-t', `=${A}:`)).out), 5000);
  step('c.paneShowsHI_42', sawHi, sawHi);

  // (d) second tab via "+", then switch back and forth
  await evaluate(`document.querySelector('.tab-add').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))`);
  await sleep(300);
  const prompted = await evaluate(`!!document.querySelector('.prompt-overlay')`);
  step('d.promptShown', prompted, prompted);
  await evaluate(`(() => { const i = document.querySelector('.prompt-input'); i.value = ${JSON.stringify(B)}; document.querySelectorAll('.prompt-box .paste-row button')[1].click(); })()`);
  const bExists = await waitFor(() => has(B));
  step('d.secondSessionExists', bExists, bExists);
  const afterAdd = await evaluate(TAB_LIST);
  step('d.tabsAfterAdd', afterAdd, afterAdd === `${A} ${B}*`);
  await click('#tabs .tab:nth-of-type(1) .tab-label');
  await sleep(500);
  const first = await evaluate(TAB_LIST);
  step('d.afterSwitchToFirst', first, first === `${A}* ${B}`);
  await click('#tabs .tab:nth-of-type(2) .tab-label');
  await sleep(500);
  const second = await evaluate(TAB_LIST);
  step('d.afterSwitchToSecond', second, second === `${A} ${B}*`);
  await sleep(400); // past the double-tap window, so the next tap is not a rename
  await click('#tabs .tab:nth-of-type(1) .tab-label');
  await sleep(500);
  const panes = await evaluate(`document.querySelectorAll('.term-pane:not(.hidden)').length`);
  step('d.visiblePanes', panes, panes === 1);

  // (e) split view: the third layout button (⊞)
  await click('#controls .tb-seg button:nth-of-type(3)');
  const mateExists = await waitFor(() => has(`${A}__b`));
  step('e.splitSessionExists', mateExists, mateExists);
  await sleep(500);
  const layout = await evaluate(`[...document.querySelectorAll('#controls .tb-seg button')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')).join(' ')`);
  step('e.layoutButtons', layout, layout.includes('⊞*'));
  const wide1 = await evaluate(SPLIT_INSETS);
  step('e.splitPanes', wide1, wide1.split(' / ').length === 2);

  // (f) resize: narrow (stacks the split), then wide again
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const narrow = await evaluate(SPLIT_INSETS);
  step('f.narrowSplit', narrow, narrow.split(' / ').length === 2 && narrow !== wide1);
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const wide2 = await evaluate(SPLIT_INSETS);
  step('f.wideSplit', wide2, wide2.split(' / ').length === 2 && wide2 !== narrow);
  step('f.cssVars', await evaluate(`['--term-h', '--keybar-h', '--kb-offset', '--kb-gap'].map((v) => v + '=' + document.documentElement.style.getPropertyValue(v)).join(' ')`));
  const sizes = await tmux('list-sessions', '-F', '#S #{window_width}x#{window_height}');
  step('f.tmuxSessions', sizes.out.trim().split('\n').join(', '));

  // (g) touch select lives in the ⋯ sheet, not on the key bar: turning it on
  // puts up the selection bar (its 取消 is the way out), and a stray tap
  // elsewhere doesn't lose it.
  const SEL_STATE = `(() => { const b = document.getElementById('selbar'); return b && !b.classList.contains('hidden') ? 'shown' : 'hidden'; })()`;
  const keyLabels = await evaluate(`[...document.querySelectorAll('#keybar .kb-key')].map((b) => b.textContent).join(' ')`);
  step('g.keybarNoSelectKey', keyLabels, !keyLabels.includes('選取'));
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.sheet-row')].find((r) => r.textContent.includes('Select text'));
    if (!row) return 'no row';
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return 'tapped';
  })()`);
  await sleep(100);
  const afterOn = await evaluate(SEL_STATE);
  step('g.selectRowShowsBar', `${opened} -> ${afterOn}`, opened === 'tapped' && afterOn === 'shown');
  await evaluate(`document.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))`);
  await sleep(100);
  step('g.barSurvivesTap', await evaluate(SEL_STATE), (await evaluate(SEL_STATE)) === 'shown');
  await evaluate(`[...document.querySelectorAll('#selbar .sel-btn')].find((b) => b.textContent === '取消')?.click()`);
  await sleep(100);
  const afterCancel = await evaluate(SEL_STATE);
  await evaluate(`document.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))`);
  await sleep(100);
  const afterCancelTap = await evaluate(SEL_STATE);
  step('g.cancelLeaves', `${afterCancel}, after a tap ${afterCancelTap}`, afterCancel === 'hidden' && afterCancelTap === 'hidden');

  if (process.env.SMOKE_VERBOSE) step('outline', `\n${await evaluate(OUTLINE)}`);
} catch (err) {
  step('run', String(err?.stack ?? err), false);
}

step('pageProblems', problems, problems.length === 0);
ws.close();
console.log(failures.length ? `\nSMOKE FAILED: ${failures.join(', ')}` : '\nSMOKE PASSED');
process.exit(failures.length ? 1 : 0);
