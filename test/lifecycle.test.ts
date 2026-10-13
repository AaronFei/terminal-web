/** Deterministic lifecycle races/exact-target regressions, only unique scratch sockets. */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realTmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim();
assert.ok(path.isAbsolute(realTmux));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error(message);
}

for (const mode of ['0', '1']) {
  describe(`explicit lifecycle ordering/exact targets (WINDOW_MODE=${mode})`, { timeout: 30_000 }, () => {
    const stamp = `${process.pid}${Math.random().toString(16).slice(2, 8)}`;
    const socket = `twlife${stamp}`;
    const session = `twlifes${stamp}`;
    const keeper = `twlifek${stamp}`;
    const prefix = `${session}Other`;
    const mate = `${session}__b`;
    const matePrefix = `${mate}Other`;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-lifecycle-'));
    const env = { ...process.env };
    delete env.TMUX; delete env.TMUX_PANE;
    const bin = path.join(temp, 'bin');
    const gate = (operation: string) => path.join(temp, `gate-${operation}`);
    const marker = (operation: string) => path.join(temp, `started-${operation}`);
    const release = (operation: string) => path.join(temp, `release-${operation}`);
    let base = '';
    let child: ChildProcess;
    let log = '';
    const clients = new Set<WebSocket>();
    const exists = (name: string) => spawnSync(realTmux, ['-L', socket, 'has-session', '-t', `=${name}`], { env, stdio: 'ignore' }).status === 0;
    const scratch = (args: string[], allowedFailure = false) => {
      assert.match(socket, /^twlife[A-Za-z0-9]+$/);
      const result = spawnSync(realTmux, ['-u', '-L', socket, ...args], { env, encoding: 'utf8' });
      if (!allowedFailure) assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    async function attach(): Promise<WebSocket> {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws?session=${session}&create=1&cols=80&rows=24`);
      clients.add(ws); ws.once('close', () => clients.delete(ws));
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return ws;
    }
    const kill = (name: string) => fetch(base + '/api/sessions/kill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    function hold(operation: string) {
      for (const file of [marker(operation), marker(operation) + '.done', release(operation)]) fs.rmSync(file, { force: true });
      fs.writeFileSync(gate(operation), '');
    }
    function unhold(operation: string) {
      fs.writeFileSync(release(operation), '');
      fs.rmSync(gate(operation), { force: true });
    }
    before(async () => {
      fs.mkdirSync(bin);
      // The wrapper gates only the requested operation and always forwards
      // the server's original argv. Scratch setup/inspection bypasses it.
      fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
operation=
has_new=0
has_detach=0
for arg in "$@"; do
  case "$arg" in
    kill-session) operation=kill ;;
    new-session) has_new=1 ;;
    -d) has_detach=1 ;;
  esac
done
if [ "$has_new" = 1 ] && [ "$has_detach" = 1 ]; then operation=create; fi
held=0
if [ -n "$operation" ] && [ -e "${temp}/gate-$operation" ]; then
  held=1
  printf '%s\\n' "$@" > "${temp}/started-$operation"
  while [ ! -e "${temp}/release-$operation" ]; do sleep 0.01; done
fi
if [ "$held" = 0 ]; then exec "${realTmux}" "$@"; fi
"${realTmux}" "$@"
result=$?
if [ "$held" = 1 ]; then printf '%s\\n' "$result" > "${temp}/started-$operation.done"; fi
exit "$result"
`, { mode: 0o755 });
      scratch(['new-session', '-d', '-s', keeper]);
      const probe = net.createServer();
      await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
      const address = probe.address();
      assert.ok(address && typeof address === 'object');
      base = `http://127.0.0.1:${address.port}`;
      await new Promise<void>(resolve => probe.close(() => resolve()));
      child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/server.ts'], {
        cwd: root,
        env: {
          ...env, PATH: `${bin}:${env.PATH}`, HOST: '127.0.0.1', PORT: String(address.port),
          MAIN_SESSION: session, TMUX_SOCKET_NAME: socket, WINDOW_MODE: mode,
          TERMINAL_WEB_STATE_DIR: path.join(temp, 'state'), UPLOAD_DIR: path.join(temp, 'upload'),
          TERMINAL_WEB_SNAPSHOT: '0', AUTH_TOKEN: '',
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', data => { log += data; });
      child.stderr?.on('data', data => { log += data; });
      await until(async () => { try { return (await fetch(base + '/api/windows')).ok; } catch { return false; } }, 'lifecycle server did not start');
      assert.match(log, new RegExp(`tmux socket: -L ${socket}`));
      assert.doesNotMatch(log, /tmux socket: default/);
    });
    after(async () => {
      unhold('create'); unhold('kill');
      for (const ws of clients) ws.terminate();
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await until(() => child.exitCode !== null || child.signalCode !== null, 'lifecycle child did not stop').catch(() => child.kill('SIGKILL'));
      }
      scratch(['kill-server'], true);
      if (process.getuid) fs.rmSync(path.join('/tmp', `tmux-${process.getuid()}`, socket), { force: true });
      fs.rmSync(temp, { recursive: true, force: true });
    });
    it('leaves prefix keepers untouched when the explicitly killed session/mate is absent', async () => {
      scratch(['new-session', '-d', '-s', prefix]);
      assert.equal(exists(session), false);
      const res = await kill(session);
      assert.equal(res.status, 200);
      assert.equal(exists(prefix), true, 'absent target must not prefix-match the keeper');
      scratch(['new-session', '-d', '-s', matePrefix]);
      assert.equal(exists(mate), false);
      const mateRes = await kill(mate);
      assert.equal(mateRes.status, 200);
      assert.equal(exists(matePrefix), true, 'absent mate must not prefix-match another session');
      assert.equal(exists(keeper), true);
    });
    it('uses an exact WS restart kill target even if that session disappears before the CLI runs', async () => {
      scratch(['new-session', '-d', '-s', session]);
      const ws = await attach();
      hold('kill');
      try {
        ws.send(JSON.stringify({ type: 'restart' }));
        await until(() => fs.existsSync(marker('kill')), 'restart kill did not reach gate');
        const argv = fs.readFileSync(marker('kill'), 'utf8').trim().split('\n');
        assert.equal(argv[argv.indexOf('-t') + 1], `=${session}`);
        scratch(['kill-session', '-t', `=${session}`]); // external disappearance
        unhold('kill');
        await until(() => fs.existsSync(marker('kill') + '.done'), 'restart kill did not finish');
        assert.equal(fs.readFileSync(marker('kill') + '.done', 'utf8').trim(), '1');
        assert.equal(exists(session), false);
        assert.equal(exists(prefix), true, 'late restart kill must not kill the prefix keeper');
        assert.equal(exists(keeper), true);
      } finally {
        unhold('kill'); ws.terminate();
      }
    });
    if (mode === '1') {
      it('orders later HTTP termination after an earlier delayed restart recreation so kill wins', async () => {
        scratch(['new-session', '-d', '-s', session]);
        const ws = await attach();
        hold('create');
        let laterKill: Promise<Response> | null = null;
        try {
          ws.send(JSON.stringify({ type: 'restart' }));
          await until(() => fs.existsSync(marker('create')), 'explicit restart recreation did not reach gate');
          assert.equal(exists(session), false, 'restart kill must precede its gated recreation');
          let acknowledged = false;
          const tombstoneFile = path.join(temp, 'state', 'closed.json');
          const previousTombstone = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8'))[session] ?? 0;
          laterKill = kill(session).then(res => { acknowledged = true; return res; });
          await until(() => {
            try { return JSON.parse(fs.readFileSync(tombstoneFile, 'utf8'))[session] > previousTombstone; }
            catch { return false; }
          }, 'later kill did not immediately persist its tombstone');
          await pause(80);
          assert.equal(acknowledged, false, 'kill must await the earlier recreation and its own execution');
          unhold('create');
          const res = await laterKill;
          assert.equal(res.status, 200);
          assert.deepEqual(await res.json(), { ok: true });
          assert.equal(exists(session), false, 'the earlier restart must not resurrect after later kill acknowledges');
          const described = await (await fetch(base + '/api/windows')).json() as { sessionPresent: boolean; windows: unknown[] };
          assert.equal(described.sessionPresent, false);
          assert.deepEqual(described.windows, []);
          assert.equal(exists(prefix), true);
          assert.equal(exists(keeper), true);
          const absent = new WebSocket(base.replace(/^http/, 'ws') + '/ws?create=1');
          const messages: string[] = [];
          absent.on('message', data => messages.push(data.toString()));
          await new Promise<void>((resolve, reject) => { absent.once('close', resolve); absent.once('error', reject); });
          assert.ok(messages.some(message => message.includes('will not create it')));
          assert.equal(exists(session), false);
        } finally {
          unhold('create'); ws.terminate();
          await laterKill?.catch(() => {});
        }
      });
    }
  });
}
