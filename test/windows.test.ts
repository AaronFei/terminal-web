/**
 * Phase-one window tabs. Talks only to a scratch tmux socket and a scratch
 * session, on 127.0.0.1 and an ephemeral port. Never targets the production
 * session "main", never uses the default socket, never restarts the service.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { loadConfig } from "../src/config.js";
import {
  configureTmuxSocket,
  currentTmuxSocketName,
  tmuxAttachArgs,
  tmuxCommand,
  selectSessionWindow,
  renameSessionWindow,
  killSessionWindow,
  listSessionWindows,
} from "../src/tmux.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = `${process.pid}${Math.random().toString(16).slice(2, 8)}`;
const socket = `twp1${stamp}`.slice(0, 64);
const session = `twp1s${stamp}`.slice(0, 64);
const otherSession = `twp1o${stamp}`.slice(0, 64);
const missingSession = `twp1m${stamp}`.slice(0, 64);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "twp1-state-"));
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "twp1-upload-"));

assert.notEqual(session, "main");
assert.notEqual(socket, "default");
assert.match(socket, /^[A-Za-z0-9_-]{1,64}$/);

let port = 0;
let missingPort = 0;
let server: ChildProcess | null = null;
let missingServer: ChildProcess | null = null;
const serverLog: string[] = [];

function envWithoutTmux(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function scratch(args: string[], allowFail = false): { status: number; stdout: string; stderr: string } {
  assert.ok(socket && socket !== "default");
  const r = spawnSync("tmux", ["-u", "-L", socket, ...args], {
    encoding: "utf8",
    env: envWithoutTmux(),
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `tmux -L ${socket} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`
    );
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function scratchWindows(allowFail = false): { id: string; name: string; active: boolean }[] {
  const out = scratch([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    "#{window_id} #{window_active} #{window_name}",
  ], allowFail);
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(@\d+) ([01]) (.*)$/.exec(line);
      if (!m) throw new Error(`bad window line ${line}`);
      return { id: m[1], active: m[2] === "1", name: m[3] };
    });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const n = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(n));
    });
    s.on("error", reject);
  });
}

function startServer(listenPort: number, mainSession: string): ChildProcess {
  const env = envWithoutTmux();
  env.HOST = "127.0.0.1";
  env.PORT = String(listenPort);
  env.TMUX_SOCKET_NAME = socket;
  env.MAIN_SESSION = mainSession;
  env.WINDOW_MODE = "1";
  env.TERMINAL_WEB_STATE_DIR = stateDir;
  env.UPLOAD_DIR = uploadDir;
  env.TERMINAL_WEB_SNAPSHOT = "0";
  env.AUTH_TOKEN = "";
  const child = spawn(path.join(repoRoot, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = (chunk: Buffer): void => {
    serverLog.push(chunk.toString());
  };
  child.stdout?.on("data", log);
  child.stderr?.on("data", log);
  return child;
}

async function waitForHttp(listenPort: number, expectedSession: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${listenPort}/api/windows`);
      if (res.ok) {
        const body = (await res.json()) as { session?: string };
        if (body.session === expectedSession) return;
        last = `wrong server/session: ${body.session} (expected ${expectedSession})`;
      } else {
        last = `status ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${listenPort} did not become ready (${last})\n${serverLog.join("")}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 3000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!exited) child.kill("SIGKILL");
}

function killScratchServer(): void {
  if (!socket || socket === "default") return;
  spawnSync("tmux", ["-L", socket, "kill-server"], { env: envWithoutTmux() });
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  if (uid !== "") {
    fs.rmSync(path.join("/tmp", `tmux-${uid}`, socket), { force: true });
  }
}

process.on("exit", () => {
  killScratchServer();
});

describe("window tab argv", () => {
  it("puts the configured socket on every tmux command and does not create a session", () => {
    configureTmuxSocket(socket);
    assert.equal(currentTmuxSocketName(), socket);
    const attach = tmuxAttachArgs(session);
    assert.deepEqual(attach.slice(0, 4), ["-u", "-L", socket, "attach-session"]);
    assert.equal(attach.at(-1), `=${session}`);
    assert.equal(attach.includes("new-session"), false);
    assert.equal(attach.includes("-A"), false);
    assert.equal(attach.includes("-f"), false);
    const listed = tmuxCommand(["list-windows", "-t", `=${session}`]);
    assert.deepEqual(listed.slice(0, 3), ["-u", "-L", socket]);
    configureTmuxSocket("");
    assert.equal(currentTmuxSocketName(), "");
    assert.equal(tmuxCommand(["list-sessions"]).includes("-L"), false);
  });

  it("refuses an invalid socket instead of falling back to the default", () => {
    assert.throws(() =>
      loadConfig({
        ...process.env,
        PORT: "9",
        HOST: "127.0.0.1",
        TMUX_SOCKET_NAME: "not a socket",
      })
    );
    assert.throws(() =>
      loadConfig({
        ...process.env,
        PORT: "9",
        HOST: "127.0.0.1",
        MAIN_SESSION: "main/evil",
      })
    );
  });
});

describe("window tabs on a scratch socket", () => {
  before(async () => {
    scratch(["new-session", "-d", "-s", session, "-n", "twp1-keep"]);
    scratch(["new-window", "-t", `=${session}`, "-n", "twp1-other"]);
    scratch(["new-session", "-d", "-s", otherSession, "-n", "twp1-foreign"]);
    port = await freePort();
    // freePort releases its probe, so a second call may reuse that port.
    // Do not silently send the missing-session tests to the existing server.
    do {
      missingPort = await freePort();
    } while (missingPort === port);
    server = startServer(port, session);
    missingServer = startServer(missingPort, missingSession);
    await waitForHttp(port, session);
    await waitForHttp(missingPort, missingSession);
    const log = serverLog.join("");
    assert.match(log, new RegExp(`tmux socket: -L ${socket}`));
    assert.doesNotMatch(log, /tmux socket: default/);
  });

  after(async () => {
    await stopChild(server);
    await stopChild(missingServer);
    killScratchServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it("lists existing windows by stable id and does not invent a session", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/windows`);
    const body = (await res.json()) as {
      mode: string;
      stage: number;
      limitation: string;
      session: string;
      sessionPresent: boolean;
      windows: { id: string; name: string; active: boolean }[];
      activeId: string;
    };
    assert.equal(res.status, 200);
    assert.equal(body.mode, "windows");
    assert.equal(body.stage, 1);
    assert.equal(body.limitation, "shared-current-window");
    assert.equal(body.session, session);
    assert.equal(body.sessionPresent, true);
    assert.equal(body.windows.length, 2);
    assert.ok(body.windows.every((w) => /^@\d+$/.test(w.id)));
    assert.equal(body.windows.filter((w) => w.active).length, 1);
    assert.equal(body.activeId, body.windows.find((w) => w.active)?.id);
    const live = scratchWindows();
    assert.deepEqual(
      body.windows.map((w) => w.id).sort(),
      live.map((w) => w.id).sort()
    );
  });

  it("does not create a missing session", async () => {
    const listed = await fetch(`http://127.0.0.1:${missingPort}/api/windows`);
    const body = (await listed.json()) as { sessionPresent: boolean; windows: unknown[] };
    assert.equal(body.sessionPresent, false);
    assert.deepEqual(body.windows, []);
    const created = await fetch(`http://127.0.0.1:${missingPort}/api/windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should-not-exist" }),
    });
    assert.equal(created.status, 409);
    const has = scratch(["has-session", "-t", `=${missingSession}`], true);
    assert.notEqual(has.status, 0);
    const names = scratch(["list-sessions", "-F", "#{session_name}"]).stdout;
    assert.equal(names.includes(missingSession), false);
    assert.equal(names.includes("main"), false);
  });

  it("creates, renames, selects, and mirrors external window changes", async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "twp1-made" }),
    });
    const createdBody = (await created.json()) as {
      ok: boolean;
      created: { id: string; name: string; active: boolean };
      activeId: string;
    };
    assert.equal(created.status, 200);
    assert.equal(createdBody.created.name, "twp1-made");
    assert.equal(createdBody.created.active, true);
    assert.equal(createdBody.activeId, createdBody.created.id);
    const afterCreate = scratchWindows();
    assert.ok(afterCreate.some((w) => w.id === createdBody.created.id && w.name === "twp1-made"));

    const renamed = await fetch(`http://127.0.0.1:${port}/api/windows/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: createdBody.created.id, name: "twp1 renamed" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(scratchWindows().find((w) => w.id === createdBody.created.id)?.name, "twp1 renamed");

    const keep = scratchWindows().find((w) => w.name === "twp1-keep");
    assert.ok(keep);
    const selected = await fetch(`http://127.0.0.1:${port}/api/windows/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: keep.id }),
    });
    const selectedBody = (await selected.json()) as { activeId: string };
    assert.equal(selected.status, 200);
    assert.equal(selectedBody.activeId, keep.id);
    assert.equal(scratchWindows().find((w) => w.id === keep.id)?.active, true);

    scratch(["new-window", "-d", "-t", `=${session}`, "-n", "twp1-external"]);
    const ext = scratchWindows().find((w) => w.name === "twp1-external");
    assert.ok(ext);
    scratch(["rename-window", "-t", ext.id, "twp1-external-renamed"]);
    const seen = (await (await fetch(`http://127.0.0.1:${port}/api/windows`)).json()) as {
      windows: { id: string; name: string }[];
    };
    assert.equal(seen.windows.find((w) => w.id === ext.id)?.name, "twp1-external-renamed");
    scratch(["kill-window", "-t", ext.id]);
    const gone = (await (await fetch(`http://127.0.0.1:${port}/api/windows`)).json()) as {
      windows: { id: string }[];
    };
    assert.equal(
      gone.windows.some((w) => w.id === ext.id),
      false
    );
  });

  it("selects a linked window only in the configured session and preserves literal rename text", async () => {
    const prior = scratchWindows().find(w => w.active)?.id;
    assert.ok(prior);
    const otherActive = scratch(["list-windows", "-t", `=${otherSession}`, "-F", "#{?window_active,#{window_id},}"]).stdout.trim();
    const linked = scratch(["new-window", "-d", "-t", `=${otherSession}`, "-P", "-F", "#{window_id}", "-n", "twp1-linked"]).stdout.trim();
    scratch(["link-window", "-d", "-s", linked, "-t", `=${session}:`]);
    try {
      const selected = await fetch(`http://127.0.0.1:${port}/api/windows/select`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: linked }),
      });
      assert.equal(selected.status, 200);
      assert.equal((await selected.json() as { activeId: string }).activeId, linked);
      assert.equal(scratchWindows().find(w => w.active)?.id, linked);
      assert.equal(scratch(["list-windows", "-t", `=${otherSession}`, "-F", "#{?window_active,#{window_id},}"]).stdout.trim(), otherActive);
      const name = `twp1 'literal' "$HOME"; path`;
      const renamed = await fetch(`http://127.0.0.1:${port}/api/windows/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: linked, name }),
      });
      assert.equal(renamed.status, 200);
      assert.equal(scratchWindows().find(w => w.id === linked)?.name, name);
      assert.equal(scratch(["display-message", "-p", "-t", `=${otherSession}:${linked}`, "#{window_name}"]).stdout.trim(), name);
      // rename-window itself expands formats, and tmux's -F output escapes
      // backslashes. The guarded command must retain direct argv semantics.
      const complex = `twp1 'quoted' "$HOME"; path\\file #{window_id}`;
      scratch(["rename-window", "-t", linked, complex]);
      const direct = scratchWindows().find(w => w.id === linked)?.name;
      const guarded = await fetch(`http://127.0.0.1:${port}/api/windows/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: linked, name: complex }),
      });
      assert.equal(guarded.status, 200);
      assert.equal(scratchWindows().find(w => w.id === linked)?.name, direct);
    } finally {
      scratch(["unlink-window", "-t", `=${session}:${linked}`], true);
      scratch(["kill-window", "-t", `=${otherSession}:${linked}`], true);
      scratch(["select-window", "-t", `=${session}:${prior}`]);
    }
  });

  it("refuses mutation after external unlink instead of tmux's current-window fallback", async () => {
    const prior = scratchWindows().find(w => w.active)?.id;
    assert.ok(prior);
    const linked = scratch(["new-window", "-d", "-t", `=${otherSession}`, "-P", "-F", "#{window_id}", "-n", "twp1-unlink-race"]).stdout.trim();
    scratch(["link-window", "-d", "-s", linked, "-t", `=${session}:`]);
    configureTmuxSocket(socket);
    try {
      // This is the endpoint's membership observation before an external CLI
      // unlink races its mutation. No test-only server interception is needed.
      assert.ok((await listSessionWindows(session))?.some(w => w.id === linked));
      scratch(["unlink-window", "-t", `=${session}:${linked}`]);
      const fallback = scratch(["display-message", "-p", "-t", `=${session}:${linked}`, "#{session_name} #{window_id}"]).stdout.trim();
      assert.equal(fallback, `${session} ${prior}`, "tmux must actually exhibit the dangerous fallback");
      const otherActive = scratch(["list-windows", "-t", `=${otherSession}`, "-F", "#{?window_active,#{window_id},}"]).stdout.trim();
      assert.equal(await selectSessionWindow(session, linked), false);
      assert.equal(await renameSessionWindow(session, linked, "should-not-rename"), false);
      assert.equal(await killSessionWindow(session, linked), "refused");
      assert.equal(scratchWindows().find(w => w.active)?.id, prior);
      assert.equal(scratch(["list-windows", "-t", `=${otherSession}`, "-F", "#{?window_active,#{window_id},}"]).stdout.trim(), otherActive);
      assert.equal(scratch(["display-message", "-p", "-t", `=${otherSession}:${linked}`, "#{window_name}"]).stdout.trim(), "twp1-unlink-race");
      for (const route of ["select", "rename", "kill"]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/windows/${route}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: linked, name: "still-not-rename", confirm: true }),
        });
        assert.equal(res.status, 404);
      }
    } finally {
      configureTmuxSocket("");
      scratch(["kill-window", "-t", `=${otherSession}:${linked}`], true);
    }
  });

  it("resolves relative downloads against the target pane cwd, not another session", async () => {
    fs.writeFileSync(path.join(uploadDir, "cwd-check.txt"), "scratch cwd contents");
    scratch(["new-window", "-t", `=${session}`, "-c", uploadDir, "-n", "twp1-cwd"]);
    const res = await fetch(`http://127.0.0.1:${port}/api/download?path=cwd-check.txt&session=${otherSession}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "scratch cwd contents");
  });

  it("rejects malformed JSON objects and invalid window identifiers/names", async () => {
    for (const [route, body] of [
      ["/api/windows", null], ["/api/windows", []], ["/api/windows", { name: "-bad" }],
      ["/api/windows/select", { id: "@1;kill-server" }],
      ["/api/windows/rename", { id: "@1", name: "-bad" }],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(scratch(["has-session", "-t", `=${session}`], true).status, 0);
  });

  it("permits explicit session management in window mode without name immunity", async () => {
    const explicit = `twexplicit${stamp}`;
    scratch(["new-session", "-d", "-s", explicit]);
    for (const endpoint of ["adopt", "rename"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(endpoint === "adopt" ? { names: [explicit] } : { name: explicit, displayName: "explicit label" }),
      });
      assert.equal(res.status, 200);
    }
    const kill = await fetch(`http://127.0.0.1:${port}/api/sessions/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: explicit }),
    });
    assert.equal(kill.status, 200);
    const killDeadline = Date.now() + 5000;
    while (scratch(["has-session", "-t", `=${explicit}`], true).status === 0 && Date.now() < killDeadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.notEqual(scratch(["has-session", "-t", `=${explicit}`], true).status, 0);

    const activeBeforeAttach = scratchWindows().find((w) => w.active)?.id;
    assert.ok(activeBeforeAttach);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?cols=40&rows=12&session=main&create=1`);
    const texts: string[] = [];
    const binaries: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) binaries.push(Buffer.from(data as Buffer));
      else texts.push(data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "ping" }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const joined = texts.join("\n");
      if (joined.includes('"pong"') && binaries.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(texts.join("\n"), /"type":"pong"/);
    assert.doesNotMatch(texts.join("\n"), /Restart is disabled/);
    assert.ok(binaries.length > 0, "ordinary attach produced no terminal bytes");
    assert.equal(
      scratchWindows().find((w) => w.active)?.id,
      activeBeforeAttach,
      "attaching must not select a different window"
    );
    assert.match(scratch(["list-sessions", "-F", "#{session_name}"]).stdout, new RegExp(session));
    const clients = scratch(["list-clients", "-F", "#{client_session}"]);
    assert.match(clients.stdout, new RegExp(session));
    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.match(scratch(["list-sessions", "-F", "#{session_name}"]).stdout, new RegExp(session));
    assert.ok(scratchWindows().length >= 2);
  });

  it("permits explicit target kill-session and restart, distinct from view reconnect", async () => {
    const killed = await fetch(`http://127.0.0.1:${port}/api/sessions/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: session }),
    });
    assert.equal(killed.status, 200);
    const deadline = Date.now() + 5000;
    while (scratch(["has-session", "-t", `=${session}`], true).status === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.notEqual(scratch(["has-session", "-t", `=${session}`], true).status, 0);
    scratch(["new-session", "-d", "-s", session, "-n", "before-restart"]);
    const old = scratchWindows()[0].id;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?cols=80&rows=24`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "restart" }));
    const restartDeadline = Date.now() + 8000;
    while (Date.now() < restartDeadline) {
      const current = scratchWindows(true)[0]?.id;
      if (current && current !== old) break;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(scratch(["has-session", "-t", `=${session}`], true).status, 0);
    assert.notEqual(scratchWindows()[0].id, old);
    ws.close();
    scratch(["new-window", "-d", "-t", `=${session}`, "-n", "twp1-after-restart"]);
  });

  it("terminates only a confirmed member window, including the final one", async () => {
    const windows = scratchWindows();
    const victim = windows.find((w) => w.name === "twp1 renamed") ?? windows.find((w) => !w.active);
    assert.ok(victim);
    const bare = await fetch(`http://127.0.0.1:${port}/api/windows/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: victim.id }),
    });
    assert.equal(bare.status, 400);
    assert.ok(scratchWindows().some((w) => w.id === victim.id));

    const foreign = scratch([
      "list-windows",
      "-t",
      `=${otherSession}`,
      "-F",
      "#{window_id}",
    ]).stdout.trim();
    const foreignSelect = await fetch(`http://127.0.0.1:${port}/api/windows/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: foreign }),
    });
    assert.equal(foreignSelect.status, 404);
    const foreignRename = await fetch(`http://127.0.0.1:${port}/api/windows/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: foreign, name: "twp1-hijacked" }),
    });
    assert.equal(foreignRename.status, 404);
    assert.equal(
      scratch(["list-windows", "-t", `=${otherSession}`, "-F", "#{window_name}"]).stdout.trim(),
      "twp1-foreign"
    );
    const foreignKill = await fetch(`http://127.0.0.1:${port}/api/windows/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: foreign, confirm: true }),
    });
    assert.equal(foreignKill.status, 404);
    assert.equal(
      scratch(["has-session", "-t", `=${otherSession}`], true).status,
      0
    );

    const killed = await fetch(`http://127.0.0.1:${port}/api/windows/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: victim.id, confirm: true }),
    });
    assert.equal(killed.status, 200);
    assert.equal(
      scratchWindows().some((w) => w.id === victim.id),
      false
    );

    // Collapse to one window, then explicitly terminate the session's final window.
    let left = scratchWindows();
    while (left.length > 1) {
      const extra = left.find((w) => !w.active) ?? left[0];
      scratch(["kill-window", "-t", extra.id]);
      left = scratchWindows();
    }
    assert.equal(left.length, 1);
    const final = await fetch(`http://127.0.0.1:${port}/api/windows/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: left[0].id, confirm: true }),
    });
    assert.equal(final.status, 200);
    const body = await final.json() as { sessionPresent: boolean; windows: unknown[] };
    assert.equal(body.sessionPresent, false);
    assert.deepEqual(body.windows, []);
    assert.notEqual(scratch(["has-session", "-t", `=${session}`], true).status, 0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?create=1`);
    const frames: string[] = [];
    ws.on("message", data => frames.push(data.toString()));
    await new Promise<void>((resolve, reject) => { ws.once("close", resolve); ws.once("error", reject); });
    assert.match(frames.join(""), /will not create it/);
    assert.notEqual(scratch(["has-session", "-t", `=${session}`], true).status, 0);
  });

  it("permits both confirmed terminates when they race, without resurrection", async () => {
    scratch(["new-session", "-d", "-s", session, "-n", "twp1-race-first"]);
    scratch(["new-window", "-d", "-t", `=${session}`, "-n", "twp1-race"]);
    const ids = scratchWindows().map((w) => w.id);
    assert.equal(ids.length, 2);
    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/windows/kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, confirm: true }),
        });
        const body = (await res.json()) as { ok?: boolean; sessionPresent?: boolean | null };
        return { id, status: res.status, body };
      })
    );
    assert.notEqual(scratch(["has-session", "-t", `=${session}`], true).status, 0);
    assert.deepEqual(results.map(r => r.status), [200, 200]);
    assert.ok(results.every(r => r.body.ok === true));
    assert.ok(results.some(r => r.body.sessionPresent === false));
  });

  it("reports absent even when final-window termination leaves no tmux server", async () => {
    scratch(["kill-session", "-t", `=${otherSession}`]);
    scratch(["new-session", "-d", "-s", session]);
    const id = scratchWindows()[0].id;
    const res = await fetch(`http://127.0.0.1:${port}/api/windows/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, confirm: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { sessionPresent: boolean }).sessionPresent, false);
    const list = await fetch(`http://127.0.0.1:${port}/api/windows`);
    assert.equal((await list.json() as { sessionPresent: boolean }).sessionPresent, false);
    assert.notEqual(scratch(["has-session", "-t", `=${session}`], true).status, 0);
  });

  it("tells a socket the session is absent and does not create it", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${missingPort}/ws?cols=40&rows=12&create=1`);
    const texts: string[] = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) texts.push(data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("absent socket did not close")), 5000);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    assert.match(texts.join("\n"), /will not create it/);
    assert.notEqual(scratch(["has-session", "-t", `=${missingSession}`], true).status, 0);
  });
});
