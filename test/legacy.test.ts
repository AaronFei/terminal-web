/** Original session-mode lifecycle against real WS/PTY/tmux, never the default socket. */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await check()) return; await pause(30); }
  throw new Error(message);
}

describe('optional window-mode configuration', () => {
  it('defaults to original session mode and supports explicit off/on values', () => {
    const env = { HOST: '127.0.0.1', PORT: '9' };
    assert.equal(loadConfig(env).windowMode, false);
    for (const value of ['', '0', 'false', 'off', 'no']) assert.equal(loadConfig({ ...env, WINDOW_MODE: value }).windowMode, false);
    for (const value of ['1', 'true', 'on', 'yes']) assert.equal(loadConfig({ ...env, WINDOW_MODE: value }).windowMode, true);
    assert.equal(loadConfig(env).mainSession, 'main');
    assert.throws(() => loadConfig({ ...env, WINDOW_MODE: 'maybe' }), /Invalid WINDOW_MODE/);
  });
});

for (const mode of [undefined, '0']) {
  describe(`original session mode (WINDOW_MODE=${mode ?? 'absent'})`, { timeout: 30_000 }, () => {
    const stamp = `${process.pid}${Math.random().toString(16).slice(2, 8)}`;
    const socket = `twlegacy${stamp}`;
    const session = `twlegacys${stamp}`;
    const mate = `${session}__b`;
    const fresh = `twlegacynew${stamp}`;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-legacy-'));
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.WINDOW_MODE;
    const sockets = new Set<WebSocket>();
    let child: ChildProcess;
    let base = '';
    let log = '';
    const scratch = (args: string[], allowedFailure = false): string => {
      assert.match(socket, /^twlegacy[A-Za-z0-9]+$/);
      const r = spawnSync('tmux', ['-u', '-L', socket, ...args], { encoding: 'utf8', env });
      if (!allowedFailure) assert.equal(r.status, 0, `scratch command failed: ${r.stderr}`);
      return r.status === 0 ? r.stdout : '';
    };
    const exists = (name: string): boolean => {
      const r = spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${name}`], { env, stdio: 'ignore' });
      return r.status === 0;
    };
    async function attach(name?: string, create = false): Promise<WebSocket> {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws?cols=80&rows=24${name ? `&session=${name}` : ''}${create ? '&create=1' : ''}`);
      sockets.add(ws);
      ws.once('close', () => sockets.delete(ws));
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return ws;
    }
    async function post(route: string, body: unknown) {
      const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, await res.clone().text());
      return res.json();
    }
    const tabs = async (): Promise<{ name: string; displayName: string }[]> => {
      const body = await (await fetch(base + '/api/sessions')).json() as { tabs: { name: string; displayName: string }[] | null };
      return body.tabs ?? [];
    };
    before(async () => {
      const probe = net.createServer();
      await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
      const address = probe.address();
      assert.ok(address && typeof address === 'object');
      const port = address.port;
      await new Promise<void>(resolve => probe.close(() => resolve()));
      base = `http://127.0.0.1:${port}`;
      child = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['src/server.ts'], {
        cwd: repoRoot,
        env: {
          ...env, ...(mode === undefined ? {} : { WINDOW_MODE: mode }),
          HOST: '127.0.0.1', PORT: String(port), DEFAULT_SESSION: session,
          MAIN_SESSION: session, TMUX_SOCKET_NAME: socket, AUTH_TOKEN: '', TERMINAL_WEB_SNAPSHOT: '0',
          TERMINAL_WEB_STATE_DIR: path.join(temp, 'state'), UPLOAD_DIR: path.join(temp, 'upload'),
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', d => { log += d; });
      child.stderr?.on('data', d => { log += d; });
      await until(async () => { try { return (await fetch(base + '/api/windows')).ok; } catch { return false; } }, 'legacy server did not start');
      assert.match(log, new RegExp(`tmux socket: -L ${socket}`));
      assert.doesNotMatch(log, /tmux socket: default/);
    });
    after(async () => {
      for (const ws of sockets) ws.terminate();
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await until(() => child.exitCode !== null || child.signalCode !== null, 'legacy server did not stop').catch(() => child.kill('SIGKILL'));
      }
      spawnSync('tmux', ['-L', socket, 'kill-server'], { env, stdio: 'ignore' });
      if (process.getuid) fs.rmSync(path.join('/tmp', `tmux-${process.getuid()}`, socket), { force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    });
    it('advertises session capabilities and rejects window endpoints', async () => {
      const res = await fetch(base + '/api/windows');
      assert.deepEqual(await res.json(), { mode: 'sessions', capabilities: { windowTabs: false, sessionTabs: true } });
      const create = await fetch(base + '/api/windows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(create.status, 404);
    });
    it('creates the default session on initialization and tags it as a tab', async () => {
      const ws = await attach();
      await until(() => exists(session), 'default session not created');
      await until(async () => (await tabs()).some(t => t.name === session), 'default session not listed');
      const messages: string[] = [];
      ws.on('message', (d, binary) => { if (!binary) messages.push(d.toString()); });
      ws.send(JSON.stringify({ type: 'ping' }));
      await until(() => messages.some(m => m.includes('pong')), 'legacy ping did not reply');
      ws.close();
    });
    it('creates a named session, renames its display label, and re-adopts existing sessions', async () => {
      const ws = await attach(fresh, true);
      await until(() => exists(fresh), 'named session not created');
      await post('/api/sessions/rename', { name: fresh, displayName: 'Legacy renamed label' });
      await until(async () => (await tabs()).some(t => t.name === fresh && t.displayName === 'Legacy renamed label'), 'label not persisted');
      scratch(['set-option', '-t', fresh, '@twtab', '0']);
      const adopted = await post('/api/sessions/adopt', { names: [fresh, 'absent-scratch-name'] }) as { adopted: string[] };
      assert.deepEqual(adopted.adopted, [fresh]);
      assert.equal(exists('absent-scratch-name'), false);
      ws.close();
    });
    it('resumes the same session/window after disconnect without recreating it', async () => {
      const id = scratch(['display-message', '-p', '-t', `=${session}:`, '#{window_id}']).trim();
      const ws = await attach(session);
      await until(() => scratch(['list-clients', '-F', '#{client_session}']).includes(session), 'no attached legacy client');
      ws.close();
      await until(() => !sockets.has(ws), 'view close did not finish');
      assert.equal(exists(session), true);
      const resumed = await attach(session);
      assert.equal(scratch(['display-message', '-p', '-t', `=${session}:`, '#{window_id}']).trim(), id);
      resumed.close();
    });
    it('creates the split mate in the base pane working directory', async () => {
      const ws = await attach(session);
      await pause(150); // allow tmux's initial terminal handshake/shell prompt
      ws.send(Buffer.from(`cd ${temp}\r`));
      await until(() => scratch(['display-message', '-p', '-t', `=${session}:`, '#{pane_current_path}']).trim() === temp, 'base cwd not changed');
      const split = await attach(mate, true);
      await until(() => exists(mate), 'split mate not created');
      assert.equal(scratch(['display-message', '-p', '-t', `=${mate}:`, '#{pane_current_path}']).trim(), temp);
      assert.equal((await tabs()).some(t => t.name === mate), false);
      ws.close(); split.close();
    });
    it('allows explicit restart of MAIN_SESSION and recreates only by legacy reconnect', async () => {
      const old = scratch(['display-message', '-p', '-t', `=${session}:`, '#{window_id}']).trim();
      const ws = await attach(session);
      const closed = new Promise<void>(resolve => ws.once('close', resolve));
      ws.send(JSON.stringify({ type: 'restart' }));
      await closed;
      await until(() => !exists(session), 'restart did not kill target');
      const freshWs = await attach(session);
      await until(() => exists(session), 'legacy reconnect did not recreate target');
      assert.notEqual(scratch(['display-message', '-p', '-t', `=${session}:`, '#{window_id}']).trim(), old);
      freshWs.close();
    });
    it('kills target plus split mate with no name immunity and refuses stale resurrection', async () => {
      await post('/api/sessions/kill', { name: session });
      await until(() => !exists(session) && !exists(mate), 'explicit target kill did not kill both halves');
      const stale = await attach(session);
      const frames: string[] = [];
      stale.on('message', (d, binary) => { if (!binary) frames.push(d.toString()); });
      await until(() => stale.readyState === WebSocket.CLOSED, 'stale view did not close');
      assert.ok(frames.some(m => m.includes('closed')));
      assert.equal(exists(session), false);
      const deliberate = await attach(session, true);
      await until(() => exists(session), 'explicit create did not clear closed tombstone');
      deliberate.close();
    });
  });
}
