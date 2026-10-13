/**
 * Real xterm/browser input regressions. No new test dependency: drive Chromium
 * via CDP using the existing ws package. Most cases use a fake HTTP/WS
 * backend; one proxies to a real server and raw-input recorders on an isolated
 * scratch tmux socket. No case writes production state or public/dist. esbuild
 * writes the current client into an OS temporary directory.
 *
 * CHROMIUM_BIN=/path/to/chromium npx tsx --test test/input.test.ts
 * Without CHROMIUM_BIN we look on PATH and in the Playwright browser cache.
 * A missing browser is reported as a skip, never as browser verification.
 * Synthetic IME traces exercise real xterm listeners, not an input mock. They
 * reproduce Safari/IME event orders but do not prove behavior on a real iPad.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import WebSocket, { WebSocketServer } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findChromium(): string | null {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    for (const name of fs.readdirSync(cache).filter(n => /^chromium-/.test(n)).sort().reverse()) {
      for (const suffix of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const bin = path.join(cache, name, suffix);
        if (fs.existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP closed'));
      this.pending.clear();
    });
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error(message);
}

const bin = findChromium();
let temp = '';
let child: ChildProcess | null = null;
let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let cdp: Cdp;
let sessionId = '';
let targetId = '';
let baseUrl = '';
let realBackend: string | null = null;
let activeId = '@0';
let fixtureMode: 'windows' | 'sessions' = 'windows';
let configurationFailure = false;
const apiRequests: string[] = [];
const fixtureSessions = new Set(['input-session']);
let controlFrames: string[] = [];
let connects = 0;
let binaryFrames: string[] = [];
const clients = new Set<WebSocket>();

async function evaluate<T = unknown>(expression: string): Promise<T> {
  const result = await cdp.command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value as T;
}

async function trace(body: string): Promise<void> {
  await evaluate(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    const key = (type, key, keyCode, extra = {}) => ta.dispatchEvent(new KeyboardEvent(type, {
      key, keyCode, bubbles: true, cancelable: true, ...extra,
    }));
    const composition = (type, data = '') => ta.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    const input = (data, extra = {}) => {
      ta.value = data;
      ta.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true, composed: true, ...extra }));
    };
    ${body}
  })()`);
}

async function hardwareKey(key: string, code: string, keyCode: number, text?: string, modifiers = 0): Promise<void> {
  await cdp.command('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers,
    ...(text !== undefined ? { text, unmodifiedText: text } : {}),
  }, sessionId);
  await cdp.command('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers,
  }, sessionId);
}

async function expectFrames(expected: string[]): Promise<void> {
  // Longer than the 90ms no-input fallback and xterm's deferred composition.
  await pause(160);
  assert.deepEqual(binaryFrames, expected);
}

describe('terminal input in real Chromium + xterm', {
  skip: !bin ? 'Chromium unavailable; set CHROMIUM_BIN to run browser regressions' : false,
  timeout: 30_000,
}, () => {
  before(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-input-test-'));
    await build({
      absWorkingDir: repoRoot,
      entryPoints: ['web/terminal.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outdir: path.join(temp, 'dist'),
      logLevel: 'silent',
    });
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (realBackend && url.pathname.startsWith('/api/')) {
        const upstream = http.request(realBackend + req.url, { method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode ?? 500, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => { res.statusCode = 502; res.end(); });
        req.pipe(upstream);
        return;
      }
      if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
      if (url.pathname.startsWith('/api/windows')) {
        if (configurationFailure) { res.statusCode = 503; res.end('unavailable'); return; }
        if (fixtureMode === 'sessions') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ mode: 'sessions', capabilities: { windowTabs: false, sessionTabs: true } }));
          return;
        }
        if (url.pathname === '/api/windows/select') activeId = '@1';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          mode: 'windows', capabilities: { windowTabs: true, sessionTabs: false }, session: 'input-fixture', sessionPresent: true, activeId,
          windows: [
            { id: '@0', index: 0, name: 'first', active: activeId === '@0' },
            { id: '@1', index: 1, name: 'second', active: activeId === '@1' },
          ],
        }));
        return;
      }
      if (url.pathname.startsWith('/api/sessions')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ tabs: [...fixtureSessions].map(name => ({ name, displayName: name })) }));
        return;
      }
      if (url.pathname === '/api/prefs') {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"prefs":{"keybar":false}}');
        return;
      }
      const file = url.pathname === '/'
        ? path.join(repoRoot, 'public', 'index.html')
        : url.pathname.startsWith('/dist/')
          ? path.join(temp, url.pathname)
          : path.join(repoRoot, 'public', url.pathname);
      try {
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(fs.readFileSync(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      if (fixtureMode === 'sessions') {
        const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
        if (name && !name.endsWith('__b')) fixtureSessions.add(name);
      }
      connects++;
      clients.add(ws);
      const upstream = realBackend ? new WebSocket(realBackend.replace(/^http/, 'ws') + req.url) : null;
      const pending: { data: WebSocket.RawData; binary: boolean }[] = [];
      upstream?.on('open', () => {
        for (const frame of pending) upstream.send(frame.data, { binary: frame.binary });
        pending.length = 0;
      });
      upstream?.on('message', (data, binary) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary });
      });
      upstream?.on('close', () => ws.close());
      upstream?.on('error', () => ws.close());
      ws.on('close', () => {
        clients.delete(ws);
        upstream?.close();
      });
      ws.on('message', (data, binary) => {
        if (binary) binaryFrames.push(data.toString());
        else controlFrames.push(data.toString());
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else if (upstream) pending.push({ data, binary });
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
    child = spawn(bin!, [
      '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'browser')}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const debuggerUrl = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${stderr}`)), 10_000);
      child!.once('error', reject);
      child!.once('exit', code => reject(new Error(`Chromium exited ${code}: ${stderr}`)));
      child!.stderr!.on('data', data => {
        stderr += data.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    cdp = await Cdp.open(debuggerUrl);
  });

  beforeEach(async () => {
    if (targetId) await cdp.command('Target.closeTarget', { targetId });
    await until(() => clients.size === 0, 'previous fixture socket did not close');
    activeId = '@0';
    fixtureMode = 'windows';
    configurationFailure = false;
    apiRequests.length = 0;
    fixtureSessions.clear();
    fixtureSessions.add('input-session');
    controlFrames = [];
    const target = await cdp.command('Target.createTarget', { url: 'about:blank' });
    targetId = target.targetId;
    const attached = await cdp.command('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
    await cdp.command('Page.enable', {}, sessionId);
    await cdp.command('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__inputSockets = []; const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) { super(...args); this.__resizeDims = []; window.__inputSockets.push(this); }
          send(data) {
            if (typeof data === 'string') {
              try { const frame = JSON.parse(data); if (frame.type === 'resize') this.__resizeDims.push({ cols: frame.cols, rows: frame.rows }); } catch {}
            }
            return super.send(data);
          }
        };`,
    }, sessionId);
    await cdp.command('Page.navigate', { url: `${baseUrl}/?webgl=0` }, sessionId);
    await until(async () => evaluate<boolean>("!!document.querySelector('.tab-dot.connected')"), 'fixture did not connect');
    // Allow the first layout rAF and both WebSocket opens to finish. A
    // connected dot alone does not prove the last startup socket is OPEN.
    await pause(160);
    await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    binaryFrames = [];
  });

  after(async () => {
    if (cdp) {
      await cdp.command('Browser.close').catch(() => {});
      cdp.ws.close();
    }
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await until(() => child!.exitCode !== null || child!.signalCode !== null, 'Chromium did not exit').catch(() => child!.kill('SIGKILL'));
    }
    for (const ws of clients) ws.terminate();
    if (wss) await new Promise<void>(resolve => wss!.close(() => resolve()));
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it('opens exactly one measured view socket during the phase-one startup/layout race', async () => {
    assert.equal(clients.size, 1);
    const startup = await evaluate<{ url: string; sizes: { cols: number; rows: number }[] }>(
      '({ url: window.__inputSockets[0].url, sizes: window.__inputSockets[0].__resizeDims })',
    );
    assert.ok(startup.sizes.length > 0, 'xterm must publish its measured terminal dimensions');
    const query = new URL(startup.url).searchParams;
    const measured = startup.sizes.at(-1)!;
    assert.deepEqual({ cols: Number(query.get('cols')), rows: Number(query.get('rows')) }, measured);
    assert.ok(startup.sizes.every(size => size.cols === measured.cols && size.rows === measured.rows), 'startup must not attach at 80x24 and correct its size later');
    await expectFrames([]);
  });

  it('fits a wide viewport before the first attach query without adding a startup socket', async () => {
    const initialConnects = connects;
    await cdp.command('Emulation.setDeviceMetricsOverride', {
      width: 1080, height: 640, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await cdp.command('Page.navigate', { url: `${baseUrl}/?webgl=0&wide=1` }, sessionId);
    await until(async () => evaluate<boolean>("!!document.querySelector('.tab-dot.connected')"), 'wide viewport view did not connect');
    await pause(160);
    const startup = await evaluate<{ url: string; sizes: { cols: number; rows: number }[]; count: number }>(
      '({ url: window.__inputSockets[0].url, sizes: window.__inputSockets[0].__resizeDims, count: window.__inputSockets.length })',
    );
    const measured = startup.sizes.at(-1)!;
    assert.ok(measured && measured.cols > 100 && measured.rows > 24, 'the viewport must differ from fallback 80x24');
    const query = new URL(startup.url).searchParams;
    assert.deepEqual({ cols: Number(query.get('cols')), rows: Number(query.get('rows')) }, measured);
    assert.ok(startup.sizes.every(size => size.cols === measured.cols && size.rows === measured.rows));
    assert.equal(startup.count, 1);
    assert.equal(clients.size, 1);
    assert.equal(connects, initialConnects + 1);
  });

  it('does not guess a mode or attach when configuration fetch fails, and retries explicitly', async () => {
    const initialConnects = connects;
    configurationFailure = true;
    await cdp.command('Page.navigate', { url: `${baseUrl}/?webgl=0&failed=1` }, sessionId);
    await until(async () => evaluate<boolean>("document.querySelector('#view-banner')?.textContent.includes('Cannot obtain server mode') ?? false"), 'initialization error not shown');
    await pause(200);
    assert.equal(connects, initialConnects);
    assert.equal(await evaluate("document.querySelectorAll('.xterm-helper-textarea').length"), 0);
    assert.equal(await evaluate("document.querySelector('.tab-add').disabled"), true);
    fixtureMode = 'sessions';
    configurationFailure = false;
    await evaluate("document.querySelector('#view-banner button').click()");
    await until(async () => evaluate<boolean>("!!document.querySelector('.tab-dot.connected')"), 'explicit initialization retry did not connect');
    assert.equal(connects, initialConnects + 1);
    assert.equal(await evaluate("document.body.classList.contains('window-mode')"), false);
  });

  it('initializes the legacy session UI, preserves repeated input and reconnect, and maps create/split/kill to sessions', async () => {
    fixtureMode = 'sessions';
    await cdp.command('Page.navigate', { url: `${baseUrl}/?webgl=0&session=input-session` }, sessionId);
    await until(async () => evaluate<boolean>("!!document.querySelector('.tab-dot.connected') && !document.body.classList.contains('window-mode')"), 'session UI did not initialize');
    await pause(160);
    binaryFrames = [];
    await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    await hardwareKey('a', 'KeyA', 65, 'a');
    await hardwareKey('a', 'KeyA', 65, 'a');
    await trace("key('keydown', '1', 229); input('1'); key('keyup', '1', 229); composition('compositionstart'); ta.value = '中'; composition('compositionend', '中'); input('中');");
    await expectFrames(['a', 'a', '1', '中']);
    const prior = connects;
    for (const ws of clients) ws.terminate();
    await until(() => connects === prior + 1 && clients.size === 1, 'legacy UI did not reconnect once');
    await evaluate("document.querySelector('.tab-add').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))");
    await until(async () => evaluate<boolean>("!!document.querySelector('.prompt-overlay')"), 'legacy create prompt absent');
    await evaluate(`(() => {
      document.querySelector('.prompt-input').value = 'browser-new';
      Array.from(document.querySelectorAll('.prompt-overlay button')).find(b => b.textContent === 'Create').click();
    })()`);
    await until(() => clients.size === 2, 'legacy new tab did not create its own socket');
    assert.ok(await evaluate<boolean>("window.__inputSockets.some(s => s.url.includes('session=browser-new') && s.url.includes('create=1'))"));
    await evaluate(`(() => {
      Array.from(document.querySelectorAll('#controls button')).find(b => b.textContent === '⊞')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    })()`);
    await until(() => clients.size === 3, 'legacy split did not open its mate socket');
    assert.ok(await evaluate<boolean>("window.__inputSockets.some(s => s.url.includes('session=browser-new__b'))"));
    await evaluate(`(() => {
      Array.from(document.querySelectorAll('#controls button')).find(b => b.textContent === '⟳')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    })()`);
    await until(() => controlFrames.some(frame => frame.includes('restart')), 'legacy restart did not use session control frame');
    await evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('#tabs .tab')).find(t => t.querySelector('.tab-label').textContent === 'browser-new');
      for (let i = 0; i < 2; i++) {
        tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        tab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      }
    })()`);
    await until(async () => evaluate<boolean>("!!document.querySelector('.prompt-overlay')"), 'legacy rename prompt absent');
    await evaluate(`(() => {
      document.querySelector('.prompt-input').value = 'Browser label';
      Array.from(document.querySelectorAll('.prompt-overlay button')).find(b => b.textContent === 'Rename').click();
    })()`);
    await until(() => apiRequests.includes('/api/sessions/rename'), 'legacy rename did not use sessions endpoint');
    await evaluate(`(() => {
      const close = document.querySelector('#tabs .tab.active .tab-close');
      close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      close.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    })()`);
    await until(async () => evaluate<boolean>("!!document.querySelector('.confirm-overlay')"), 'legacy close confirmation absent');
    await evaluate("document.querySelector('.confirm-overlay .danger').click()");
    await until(() => apiRequests.includes('/api/sessions/kill'), 'legacy close did not use sessions kill endpoint');
    assert.equal(apiRequests.includes('/api/windows/select'), false);
    assert.equal(apiRequests.includes('/api/windows/kill'), false);
  });

  it('sends each trusted hardware character once, including intentional repeats', async () => {
    for (const ch of 'helloo111') {
      await hardwareKey(ch, /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), ch);
    }
    await expectFrames('helloo111'.split(''));
  });

  it('preserves trusted special keys and physical auto-repeat', async () => {
    await hardwareKey('Enter', 'Enter', 13, '\r');
    await hardwareKey('Tab', 'Tab', 9);
    await hardwareKey('Backspace', 'Backspace', 8);
    await hardwareKey('ArrowLeft', 'ArrowLeft', 37);
    await hardwareKey('ArrowUp', 'ArrowUp', 38);
    await hardwareKey('c', 'KeyC', 67, undefined, 2);
    for (let i = 0; i < 3; i++) {
      await cdp.command('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
        text: 'a', unmodifiedText: 'a', autoRepeat: i > 0,
      }, sessionId);
    }
    await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, sessionId);
    await expectFrames(['\r', '\t', '\x7f', '\x1b[D', '\x1b[A', '\x03', 'a', 'a', 'a']);
  });

  it('keeps the iOS 229 printable fallback when there is no input event', async () => {
    await trace("key('keydown', '1', 229); key('keyup', '1', 229);");
    await expectFrames(['1']);
  });

  it('does not send a 229 key twice when keypress also occurs', async () => {
    await trace("key('keydown', '1', 229); key('keypress', '1', 49, { charCode: 49, which: 49 }); key('keyup', '1', 229);");
    await expectFrames(['1']);
  });

  it('does not send a 229 key twice when input occurs after keyup', async () => {
    await trace("key('keydown', '2', 229); key('keyup', '2', 229); input('2');");
    await expectFrames(['2']);
  });

  it('delivers 229 insertText before keyup, which xterm normally drops', async () => {
    await trace("key('keydown', '3', 229); input('3'); key('keyup', '3', 229);");
    await expectFrames(['3']);
  });

  it('does not duplicate a late input event after the no-input rescue fired', async () => {
    await trace("key('keydown', '4', 229); key('keyup', '4', 229);");
    await pause(120);
    await trace("input('4');");
    await expectFrames(['4']);
  });

  it('uses inserted full-width text instead of the unconverted 229 key', async () => {
    await trace("key('keydown', '1', 229); input('１'); key('keyup', '1', 229);");
    await expectFrames(['１']);
  });

  it('prefers converted input even if a 229 keypress also occurs', async () => {
    await trace("key('keydown', '1', 229); key('keypress', '1', 49, { charCode: 49 }); input('１'); key('keyup', '1', 229);");
    await expectFrames(['１']);
  });

  it('keeps input-only emoji and repeated input after the 229 rescue', async () => {
    await trace("key('keydown', '1', 229); key('keyup', '1', 229);");
    await pause(120);
    await cdp.command('Input.insertText', { text: '😀' }, sessionId);
    await cdp.command('Input.insertText', { text: '😀' }, sessionId);
    await expectFrames(['1', '😀', '😀']);
  });

  it('preserves rapid intentional repeated 229 keys', async () => {
    await trace("key('keydown', '1', 229); key('keyup', '1', 229); key('keydown', '1', 229); key('keyup', '1', 229);");
    await expectFrames(['1', '1']);
  });

  it('cancels a pending rescue when composition starts and never forwards pre-edit', async () => {
    await trace("key('keydown', 'a', 229); composition('compositionstart'); ta.value = 'ㄅ'; composition('compositionupdate', 'ㄅ'); key('keydown', 'b', 229, { isComposing: true }); key('keyup', 'b', 229); ");
    await pause(130);
    assert.deepEqual(binaryFrames, []);
    await trace("composition('compositionend', '中'); input('中', { inputType: 'insertCompositionText' });");
    await expectFrames(['中']);
  });

  it('sends an ASCII composition commit once even with a trailing insertText', async () => {
    await trace("composition('compositionstart'); ta.value = 'abc'; composition('compositionupdate', 'abc'); composition('compositionend', 'x'); input('x');");
    await expectFrames(['x']);
  });

  it('preserves deliberately identical rapid CJK commits and subsequent direct text', async () => {
    await trace("composition('compositionstart'); ta.value = '中'; composition('compositionupdate', '中'); composition('compositionend', '中'); input('中', { inputType: 'insertCompositionText' }); composition('compositionstart'); ta.value = '中'; composition('compositionupdate', '中'); composition('compositionend', '中'); input('中', { inputType: 'insertCompositionText' });");
    await pause(30);
    await cdp.command('Input.insertText', { text: '中' }, sessionId);
    await expectFrames(['中', '中', '中']);
  });

  it('does not leak a cancelled composition or finalize it early on CapsLock', async () => {
    await trace("composition('compositionstart'); ta.value = 'abc'; composition('compositionupdate', 'abc');");
    await pause(10);
    await trace("key('keydown', 'CapsLock', 20); composition('compositionend', ''); input('', { inputType: 'insertCompositionText' });");
    await expectFrames([]);
  });

  it('suppresses deferred xterm pre-edit when a new composition starts in the same task', async () => {
    await trace("composition('compositionstart'); ta.value = '中'; composition('compositionupdate', '中'); composition('compositionend', '中'); composition('compositionstart'); ta.value = 'ㄅ'; composition('compositionupdate', 'ㄅ');");
    await pause(30);
    assert.deepEqual(binaryFrames, ['中']);
    await trace("composition('compositionend', '文'); input('文', { inputType: 'insertCompositionText' });");
    await expectFrames(['中', '文']);
  });

  it('keeps continued Bopomofo pre-edit out after a partial commit without a new compositionstart', async () => {
    await trace("composition('compositionstart'); ta.value = '中ㄅ'; composition('compositionupdate', '中ㄅ'); composition('compositionend', '中'); input('ㄅ', { inputType: 'insertCompositionText', isComposing: true });");
    await pause(30);
    assert.deepEqual(binaryFrames, ['中']);
    await trace("composition('compositionupdate', 'ㄅㄆ'); ta.value = 'ㄅㄆ'; key('keydown', 'b', 229, { isComposing: true });");
    await pause(120);
    assert.deepEqual(binaryFrames, ['中']);
    await trace("composition('compositionend', '文'); input('文', { inputType: 'insertCompositionText' });");
    await expectFrames(['中', '文']);
  });

  it('does not latch ownership if the final post-composition input retains isComposing', async () => {
    await trace("composition('compositionstart'); ta.value = 'x'; composition('compositionupdate', 'x'); composition('compositionend', 'x'); input('x', { inputType: 'insertCompositionText', isComposing: true });");
    await pause(30);
    await hardwareKey('a', 'KeyA', 65, 'a');
    await expectFrames(['x', 'a']);
  });

  it('does not lose a native paste during active composition', async () => {
    await trace("composition('compositionstart'); ta.value = 'ㄅ'; composition('compositionupdate', 'ㄅ');");
    await evaluate(`(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'paste');
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    })()`);
    await trace("composition('compositionend', ''); input('', { inputType: 'insertCompositionText' });");
    await expectFrames(['paste']);
  });

  it('recovers normal hardware input after a blur without compositionend', async () => {
    await trace("composition('compositionstart'); ta.value = 'ㄅ'; composition('compositionupdate', 'ㄅ');");
    await pause(10); // xterm records its pre-edit end offset asynchronously
    await trace("ta.blur(); ta.focus();");
    await hardwareKey('a', 'KeyA', 65, 'a');
    await expectFrames(['a']);
  });

  it('handles a native Chromium IME composition transaction exactly once', async () => {
    await cdp.command('Input.imeSetComposition', { text: 'ㄅ', selectionStart: 1, selectionEnd: 1 }, sessionId);
    await cdp.command('Input.insertText', { text: '中' }, sessionId);
    await expectFrames(['中']);
  });

  it('sends paste once, leaves no stale textarea text, and can compose afterwards', async () => {
    await evaluate(`(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'hello\\nworld');
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    })()`);
    await trace("composition('compositionstart'); ta.value = '中'; composition('compositionupdate', '中'); composition('compositionend', '中'); input('中', { inputType: 'insertCompositionText' });");
    await expectFrames(['hello\rworld', '中']);
    assert.equal(await evaluate("document.querySelector('.xterm-helper-textarea').value"), '');
  });

  it('keeps an active composition intact across reconnect and commits it once', async () => {
    const initialConnects = connects;
    await trace("composition('compositionstart'); ta.value = 'ㄅ'; composition('compositionupdate', 'ㄅ');");
    for (const ws of clients) ws.terminate();
    await until(() => connects === initialConnects + 1 && clients.size === 1, 'browser did not reconnect during composition');
    await pause(100);
    assert.equal(await evaluate("document.querySelector('.xterm-helper-textarea').value"), 'ㄅ');
    assert.deepEqual(binaryFrames, []);
    await trace("composition('compositionend', '中'); input('中', { inputType: 'insertCompositionText' });");
    await expectFrames(['中']);
  });

  it('ignores a delayed old close after Close view / immediate Reconnect view', async () => {
    const initialConnects = connects;
    await evaluate(`(() => {
      const old = window.__inputSockets[0];
      window.__delayedInputClose = old.onclose;
      old.onclose = null; // deliver this real close only after the new open
      Array.from(document.querySelectorAll('#controls button')).find(b => b.textContent === 'Close view')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      document.querySelector('#view-banner button').click();
    })()`);
    await until(() => connects === initialConnects + 1 && clients.size === 1, 'view did not resume once');
    await until(async () => evaluate<boolean>("!!document.querySelector('.tab-dot.connected')"), 'resumed view did not open');
    await evaluate("window.__delayedInputClose(new CloseEvent('close'))");
    assert.equal(await evaluate("!!document.querySelector('.tab-dot.connected')"), true);
    await hardwareKey('a', 'KeyA', 65, 'a');
    await expectFrames(['a']);
    assert.equal(connects, initialConnects + 1);
  });

  it('runs the real WS → pty → tmux path once on an isolated scratch socket', async () => {
    // The proxy serves our TEMP bundle while API/WS use a real scratch server.
    // The recorder's raw stdin, rather than shell echo, is the input oracle.
    await cdp.command('Target.closeTarget', { targetId });
    targetId = '';
    await until(() => clients.size === 0, 'mock view did not close');
    const stamp = `${process.pid}${Math.random().toString(16).slice(2, 8)}`;
    const socket = `twi${stamp}`;
    const session = `twis${stamp}`;
    assert.notEqual(socket, 'default');
    assert.notEqual(session, 'main');
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const scratch = (args: string[]): string => {
      const result = spawnSync('tmux', ['-u', '-L', socket, ...args], { encoding: 'utf8', env });
      assert.equal(result.status, 0, `scratch tmux failed: ${result.stderr}`);
      return result.stdout;
    };
    const firstFile = path.join(temp, 'first-input.bin');
    const secondFile = path.join(temp, 'second-input.bin');
    const recorder = path.join(temp, 'record-input.mjs');
    fs.writeFileSync(recorder, `import fs from 'node:fs';
      process.stdin.setRawMode(true);
      fs.writeFileSync(process.argv[2], '');
      process.stdin.on('data', data => fs.appendFileSync(process.argv[2], data));
      process.stdout.write('recorder ready\\n');
    `);
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    let scratchServer: ChildProcess | null = null;
    let log = '';
    try {
      scratch(['new-session', '-d', '-s', session, '-n', 'input-first', `${process.execPath} ${recorder} ${firstFile}`]);
      scratch(['new-window', '-d', '-t', `=${session}`, '-n', 'input-second', `${process.execPath} ${recorder} ${secondFile}`]);
      await until(() => fs.existsSync(firstFile) && fs.existsSync(secondFile), 'raw recorders did not start');
      const ids = scratch(['list-windows', '-t', `=${session}`, '-F', '#{window_id}']).trim().split('\n');
      assert.equal(ids.length, 2);
      scratchServer = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['src/server.ts'], {
        cwd: repoRoot,
        env: {
          ...env, HOST: '127.0.0.1', PORT: String(port), TMUX_SOCKET_NAME: socket,
          MAIN_SESSION: session, WINDOW_MODE: '1', TERMINAL_WEB_SNAPSHOT: '0', AUTH_TOKEN: '',
          TERMINAL_WEB_STATE_DIR: path.join(temp, 'scratch-state'), UPLOAD_DIR: path.join(temp, 'scratch-upload'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      scratchServer.stdout?.on('data', data => { log += data.toString(); });
      scratchServer.stderr?.on('data', data => { log += data.toString(); });
      realBackend = `http://127.0.0.1:${port}`;
      await until(async () => {
        try { return (await fetch(realBackend + '/api/windows')).ok; } catch { return false; }
      }, 'scratch HTTP server did not start');
      assert.match(log, new RegExp(`tmux socket: -L ${socket}`));
      const target = await cdp.command('Target.createTarget', { url: 'about:blank' });
      targetId = target.targetId;
      sessionId = (await cdp.command('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      await cdp.command('Page.enable', {}, sessionId);
      await cdp.command('Page.navigate', { url: `${baseUrl}/?webgl=0` }, sessionId);
      const countClients = (): number => scratch(['list-clients', '-F', '#{client_session}']).trim().split('\n').filter(Boolean).length;
      await until(async () => evaluate<boolean>("!!document.querySelector('.tab-dot.connected')"), 'scratch view did not connect');
      await pause(250);
      assert.equal(clients.size, 1, 'the browser must have one WebSocket');
      assert.equal(countClients(), 1, 'the real backend must have one attached tmux client/pty');
      binaryFrames = [];
      await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
      await hardwareKey('a', 'KeyA', 65, 'a');
      await hardwareKey('a', 'KeyA', 65, 'a');
      await trace("key('keydown', '1', 229); key('keypress', '1', 49, { charCode: 49 }); input('1'); key('keyup', '1', 229);");
      await cdp.command('Input.imeSetComposition', { text: 'ㄅ', selectionStart: 1, selectionEnd: 1 }, sessionId);
      await cdp.command('Input.insertText', { text: '中' }, sessionId);
      await until(() => fs.readFileSync(firstFile, 'utf8') === 'aa1中', 'scratch recorder did not receive aa1中 exactly once');
      await expectFrames(['a', 'a', '1', '中']);
      await evaluate(`(() => {
        const tab = document.querySelector('[data-window-id="${ids[1]}"]');
        tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        tab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      })()`);
      await until(async () => evaluate<boolean>(`!!document.querySelector('[data-window-id="${ids[1]}"].active')`), 'real window tab did not select');
      await hardwareKey('a', 'KeyA', 65, 'a');
      await until(() => fs.readFileSync(secondFile, 'utf8') === 'a', 'typing did not reach the selected scratch window');
      assert.equal(countClients(), 1);
      const initialConnects = connects;
      for (const ws of clients) ws.terminate();
      await until(() => connects === initialConnects + 1 && countClients() === 1, 'scratch view did not reconnect to one pty');
      await pause(150);
      await hardwareKey('b', 'KeyB', 66, 'b');
      await until(() => fs.readFileSync(secondFile, 'utf8') === 'ab', 'reconnected scratch input duplicated or was lost');
      assert.equal(fs.readFileSync(firstFile, 'utf8'), 'aa1中');
      assert.equal(clients.size, 1);
      assert.equal(countClients(), 1);

      await evaluate(`Array.from(document.querySelectorAll('#controls button')).find(b => b.textContent === 'Close view')
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))`);
      await until(() => clients.size === 0 && countClients() === 0, 'Close view did not detach the real pty');
      assert.equal(scratch(['list-windows', '-t', `=${session}`, '-F', '#{window_id}']).trim().split('\n').length, 2);
      await evaluate("document.querySelector('#view-banner button').click()");
      await until(() => clients.size === 1 && countClients() === 1, 'Reconnect view did not attach once');
      for (const id of ids) {
        await evaluate(`(() => {
          const end = document.querySelector('[data-window-id="${id}"] .tab-terminate');
          end.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          end.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        })()`);
        await until(async () => evaluate<boolean>("!!document.querySelector('.confirm-overlay')"), 'window termination confirmation absent');
        assert.ok(await evaluate<boolean>("document.querySelector('.confirm-overlay').textContent.includes('final window')"));
        await evaluate("document.querySelector('.confirm-overlay .danger').click()");
        await until(async () => evaluate<boolean>(`!document.querySelector('[data-window-id="${id}"]')`), 'terminated real window remained in UI');
      }
      await until(async () => evaluate<boolean>("document.querySelector('#view-banner').textContent.includes('not running')"), 'final-window termination did not show missing session');
      await until(() => clients.size === 0, 'final-window termination left a view connected');
      const afterTermination = connects;
      await pause(2200); // include the 2s window poll; it must not recreate the session
      assert.equal(connects, afterTermination);
      assert.notEqual(spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${session}`], { env, stdio: 'ignore' }).status, 0);
    } finally {
      if (targetId) await cdp.command('Target.closeTarget', { targetId }).catch(() => {});
      targetId = '';
      await until(() => clients.size === 0, 'scratch view did not close').catch(() => {});
      realBackend = null;
      if (scratchServer && scratchServer.exitCode === null) {
        scratchServer.kill('SIGTERM');
        await until(() => scratchServer!.exitCode !== null || scratchServer!.signalCode !== null, 'scratch server did not exit').catch(() => scratchServer!.kill('SIGKILL'));
      }
      spawnSync('tmux', ['-L', socket, 'kill-server'], { env });
      if (typeof process.getuid === 'function') {
        fs.rmSync(path.join('/tmp', `tmux-${process.getuid()}`, socket), { force: true });
      }
    }
  });

  it('does not add input listeners or sockets when changing window tabs or reconnecting', async () => {
    const initialConnects = connects;
    for (let i = 0; i < 3; i++) {
      await evaluate("document.querySelector('[data-window-id=\"@1\"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }))");
      await evaluate("document.querySelector('[data-window-id=\"@1\"]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }))");
      await pause(400);
    }
    assert.equal(await evaluate("document.querySelectorAll('.xterm-helper-textarea').length"), 1);
    assert.equal(connects, initialConnects);
    for (const ws of clients) ws.terminate();
    await until(() => connects === initialConnects + 1 && clients.size === 1, 'browser did not reconnect once');
    await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    await hardwareKey('a', 'KeyA', 65, 'a');
    await expectFrames(['a']);
    assert.equal(connects, initialConnects + 1);
  });
});
