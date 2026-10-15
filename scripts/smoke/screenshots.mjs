// Regenerates docs/screenshot.png (desktop) and docs/mobile.png (phone) from a
// scratch server. Run it through run-smoke.sh, which sets up the server, the
// scratch HOME with a plain prompt, and headless Chrome, and cleans up:
//
//   bash scripts/smoke/run-smoke.sh --screenshots
//
// Usage: node screenshots.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket>
//
// Three tabs (api, web, logs); `web` lists this repo and its recent commits.
// Commands are typed with `tmux send-keys` on the scratch socket only.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const [repoDir, cdpPort, baseUrl, sock] = process.argv.slice(2);
if (!repoDir || !cdpPort || !baseUrl || !sock) {
  console.error('usage: node screenshots.mjs <repoDir> <cdpPort> <baseUrl> <tmuxSocket>');
  process.exit(2);
}
const outDir = path.join(repoDir, 'docs');
const require = createRequire(path.join(repoDir, 'package.json'));
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) =>
  new Promise((resolve) => {
    execFile('env', ['-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-L', sock, ...args], (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout), err: String(stderr) }),
    );
  });
/** Type one line into a session's shell and give it a moment to run. */
const type = async (session, line) => {
  await tmux('send-keys', '-t', `=${session}:`, '-l', line);
  await tmux('send-keys', '-t', `=${session}:`, 'Enter');
  await sleep(700);
};

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.once('open', r));
let nextId = 1;
const pending = new Map();
let failed = false;
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    failed = true;
    console.log('page exception:', msg.params.exceptionDetails.exception?.description);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, file), Buffer.from(r.data, 'base64'));
  console.log(`wrote docs/${file}`);
};

await send('Runtime.enable');
await send('Page.enable');

// Desktop: 1120x500 CSS px at 2x.
await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 500, deviceScaleFactor: 2, mobile: false });
for (const s of ['api', 'web', 'logs']) {
  await send('Page.navigate', { url: `${baseUrl}/?session=${s}&webgl=0` });
  await sleep(2000);
}
await type('api', 'clear');
await type('logs', 'clear');
await type('web', `cd ${repoDir} && clear`);
await type('web', 'ls');
await type('web', 'git log --oneline -12');
await send('Page.navigate', { url: `${baseUrl}/?session=web&webgl=0` });
await sleep(2500);
await evaluate(`document.querySelector('.term-pane:not(.hidden) .xterm-helper-textarea')?.focus()`);
await sleep(800);
console.log('desktop tabs:', await evaluate(`[...document.querySelectorAll('#tabs .tab .tab-label')].map((t) => t.textContent).join(' ')`));
await shot('screenshot.png');

// Phone: 375x750 CSS px at 1.2x, with touch, so the phone bar and key bar show.
await evaluate('localStorage.clear()'); // the desktop run saved "key bar hidden"
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 750, deviceScaleFactor: 1.2, mobile: true });
await send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
});
await send('Page.navigate', { url: `${baseUrl}/?session=web&webgl=0` });
await sleep(2500);
await type('web', 'clear');
await type('web', 'ls');
await type('web', 'git log --oneline -6');
await sleep(1200);
console.log('phone key bar:', await evaluate(`[...document.querySelectorAll('#keybar > *')].map((e) => e.textContent || '|').join(' ')`));
await shot('mobile.png');

ws.close();
process.exit(failed ? 1 : 0);
