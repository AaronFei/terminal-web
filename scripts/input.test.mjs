// Browser regression checks with real xterm.js and synthetic keyboard events.
// The API and WebSocket are fixtures: no shell, tmux, or live service is opened.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const publicRoot = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const android = 'Mozilla/5.0 (Linux; Android 17; Pixel 8) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36';
const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
let browser;
let server;
let base;

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/sessions' ? { tabs: [{ name: 'fixture' }] } : {}));
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(publicRoot + sep)) { res.writeHead(403).end(); return; }
    try {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.setHeader('Content-Type', type);
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
});

async function fixture(t, userAgent = android) {
  const context = await browser.newContext({ userAgent, viewport: { width: 412, height: 915 }, hasTouch: true });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {
      get: () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Linux aarch64',
    });
    window.terminalBytes = [];
    window.fixtureSockets = [];
    window.WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 0;
      constructor() {
        window.fixtureSockets.push(this);
        setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
      }
      send(data) {
        if (typeof data !== 'string') window.terminalBytes.push(new TextDecoder().decode(data));
      }
      close() { this.readyState = 3; this.onclose?.({}); }
    };
  });
  await page.goto(base + '/?webgl=0');
  await page.waitForFunction(() => window.fixtureSockets[0]?.readyState === 1);
  await page.locator('.xterm-helper-textarea').focus();
  return page;
}
const sent = (page) => page.evaluate(() => window.terminalBytes.join(''));

// Gboard can send keyCode 229 + insertText without any compositionend. These
// are DOM event traces, not Playwright keyboard.type (which emulates a desktop).
async function gboardText(page, text) {
  for (const char of text) {
    await page.evaluate((char) => {
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      ta.value += char;
      ta.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true, composed: true }));
    }, char);
    await page.waitForTimeout(15); // xterm's textarea diff is deferred one tick
    await page.evaluate(() => document.querySelector('.xterm-helper-textarea').dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true }),
    ));
  }
}
async function composing(page, words) {
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    window.compositionPrefix = ta.value;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  for (const word of words) {
    await page.evaluate((word) => {
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, isComposing: true, bubbles: true }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: word, bubbles: true }));
      ta.value = window.compositionPrefix + word;
      ta.dispatchEvent(new InputEvent('input', { data: word, inputType: 'insertCompositionText', isComposing: true, bubbles: true, composed: true }));
    }, word);
    await page.waitForTimeout(15);
  }
}
async function commit(page, text, enter = false) {
  await page.evaluate(({ text, enter }) => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true, composed: true }));
    if (enter) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true }));
  }, { text, enter });
  await page.waitForTimeout(25);
}

test('Android: Gboard insertText reaches the socket once, including repeated Unicode', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'echo test éé');
  assert.equal(await sent(page), 'echo test éé');
  await page.keyboard.press('Enter');
  await gboardText(page, 'echo again');
  assert.equal(await sent(page), 'echo test éé\recho again');
});

test('Android: predictive composition is visible and commits only its final text', async (t) => {
  const page = await fixture(t);
  await composing(page, ['t', 'ts', 'tset', 'test']);
  assert.equal(await sent(page), '');
  assert.match(await page.locator('.composition-view.active').textContent(), /test/);
  await commit(page, 'test', true); // Enter before the deferred commit must not duplicate it
  assert.equal(await sent(page), 'test\r');
  await composing(page, ['é']);
  await commit(page, 'é');
  await composing(page, ['é']);
  await commit(page, 'é');
  assert.equal(await sent(page), 'test\réé');
});

test('Android: paste, Backspace and subsequent Gboard input do not replay the paste', async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'pasted');
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    ta.dispatchEvent(event);
    // Emulate the browser's default insertion only when it was not prevented.
    if (!event.defaultPrevented) ta.value += 'pasted';
  });
  await page.keyboard.press('Backspace');
  await gboardText(page, 'xy');
  assert.equal(await sent(page), 'pasted\x7fxy');
});

test('Android: Gboard 229-only deletion sends one Backspace', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'abc');
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
    ta.value = ta.value.slice(0, -1);
    ta.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
  });
  await page.waitForTimeout(15);
  await gboardText(page, 'd');
  assert.equal(await sent(page), 'abc\x7fd');
});

test('Android: reconnect during composition preserves the pending commit', async (t) => {
  const page = await fixture(t);
  await composing(page, ['test']);
  await page.evaluate(() => window.fixtureSockets[0].close());
  await page.waitForFunction(() => window.fixtureSockets[1]?.readyState === 1);
  assert.equal(await page.locator('.xterm-helper-textarea').inputValue(), 'test');
  await commit(page, 'test');
  assert.equal(await sent(page), 'test');
  await gboardText(page, '1');
  assert.equal(await sent(page), 'test1');
});

test('iOS: custom composition commits once and 229-only punctuation still works', async (t) => {
  const page = await fixture(t, ios);
  await composing(page, ['你好']);
  await commit(page, '你好');
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').dispatchEvent(
    new KeyboardEvent('keydown', { key: '1', keyCode: 229, bubbles: true }),
  ));
  await page.waitForTimeout(120);
  assert.equal(await sent(page), '你好1');
});

test('desktop: ordinary typing and Ctrl+C retain their native terminal behavior', async (t) => {
  const page = await fixture(t, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36');
  await page.keyboard.type('echo desktop');
  await page.keyboard.press('Control+c');
  assert.equal(await sent(page), 'echo desktop\x03');
});
