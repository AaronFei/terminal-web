import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { URL } from "node:url";

import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

import { loadConfig } from "./config.js";
import {
  sanitizeSession,
  tmuxArgs,
  ensureTmuxAvailable,
  tagWebSession,
  setWebTabLabel,
  listWebTabs,
} from "./tmux.js";
import type { ServerMessage } from "./types.js";
import { isClientMessage } from "./types.js";
import { gateHttp, isAuthed } from "./auth.js";

const config = loadConfig();

// The cross-device tab list lives on the tmux sessions themselves (a @twtab
// user option), so it can't drift from reality — see tmux.ts. This set just
// tracks sessions with a live WebSocket right now, so a freshly-connected tab
// shows up in /api/sessions immediately, before its tag write has landed.
const liveSessions = new Set<string>();

// Every WebSocket currently attached to each session name. Used to tell the
// *other* devices on a session that it was closed, so they drop the tab instead
// of auto-reconnecting (which would resurrect the just-killed tmux session).
const sessionClients = new Map<string, Set<WebSocket>>();

function addSessionClient(name: string, ws: WebSocket): void {
  let set = sessionClients.get(name);
  if (!set) {
    set = new Set();
    sessionClients.set(name, set);
  }
  set.add(ws);
}

function removeSessionClient(name: string, ws: WebSocket): void {
  const set = sessionClients.get(name);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sessionClients.delete(name);
}

/** Tell every client of `name` except `except` that the session was closed. */
function broadcastClosed(name: string, except: WebSocket): void {
  const set = sessionClients.get(name);
  if (!set) return;
  for (const peer of set) {
    if (peer !== except) sendJson(peer, { type: "closed" });
  }
}

// Short hostname of the machine running this server, used to label the page
// title so several hosts open in different tabs are easy to tell apart. Strip
// any DNS domain suffix (e.g. "nuc.local" -> "nuc").
const HOST_LABEL = os.hostname().replace(/\..*$/, "") || os.hostname();

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request URL pathname to an absolute file path under publicDir.
 * Returns null for unknown routes. Guards against path traversal by resolving
 * and confirming the result stays within publicDir.
 */
function resolveStaticPath(pathname: string): string | null {
  let rel: string | null = null;

  if (pathname === "/" || pathname === "/index.html") {
    rel = "index.html";
  } else if (pathname === "/styles.css") {
    rel = "styles.css";
  } else if (pathname.startsWith("/dist/")) {
    // Anything emitted by esbuild: terminal.js, terminal.css, *.map, etc.
    rel = "dist/" + pathname.slice("/dist/".length);
  } else {
    return null;
  }

  // Normalize and ensure the resolved path is inside publicDir.
  const target = path.resolve(config.publicDir, rel);
  const root = path.resolve(config.publicDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null; // traversal attempt
  }
  return target;
}

/**
 * Serve index.html with the machine's hostname injected into <title>, so each
 * host shows up as a distinct browser tab. The file is tiny, so reading it per
 * request is fine (responses are no-cache anyway).
 */
async function serveIndexHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string
): Promise<void> {
  let html: string;
  try {
    html = await fsp.readFile(filePath, "utf8");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const title = `${escapeHtml(HOST_LABEL)} · terminal-web`;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): Promise<void> {
  if (pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    await serveIndexHtml(req, res, filePath);
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    console.error(`[static] read error for ${filePath}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// File upload (POST /upload): save a pasted/dropped/attached file to disk so
// the program in the terminal (e.g. Claude Code) can read it by path. The
// client sends the raw bytes as the body, the file's Content-Type as a header,
// and the original filename as ?name= so we can preserve its extension/name.
// Any file type is accepted — not just images.
// ---------------------------------------------------------------------------

// Fallback extensions for common image types, used only when the client sends
// no usable filename (e.g. a clipboard image paste has no name).
const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tiff",
};

/**
 * Reduce a client-supplied filename to a safe basename for our upload dir:
 * strip any directory components, collapse anything outside [A-Za-z0-9._-] to
 * "_", drop leading dots (no hidden/".." names), and bound the length while
 * keeping the extension. Returns null if nothing usable remains.
 */
function safeUploadBaseName(raw: string | null): string | null {
  if (!raw) return null;
  let base = raw.replace(/\\/g, "/");
  base = base.slice(base.lastIndexOf("/") + 1); // basename only
  base = base.replace(/[^A-Za-z0-9._-]+/g, "_"); // collapse unsafe chars (incl. spaces)
  base = base.replace(/^[.]+/, ""); // never start with a dot
  if (base.length > 96) {
    const ext = path.extname(base).slice(0, 16);
    base = base.slice(0, 96 - ext.length) + ext;
  }
  return base.length ? base : null;
}

function sendJsonHttp(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read a small request body fully, rejecting anything over `maxBytes`. */
async function readBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Cross-device tab sync (GET/POST /api/sessions...). The tab list lives on the
// server so any browser sees the same sessions; display names persist here too.
// ---------------------------------------------------------------------------

/**
 * Return the web tabs, sourced from tmux (sessions carrying the @twtab tag),
 * unioned with sessions that have a live WebSocket right now (covering the
 * brief window between a tab connecting and its tag write completing). When
 * tmux can't be queried, reply with `tabs: null` so the client keeps its
 * current tabs instead of wrongly clearing them.
 */
async function handleListSessions(res: http.ServerResponse): Promise<void> {
  const tagged = await listWebTabs();
  if (tagged === null) {
    sendJsonHttp(res, 200, { tabs: null }); // unknown -> client keeps its state
    return;
  }
  const byName = new Map(tagged.map((t) => [t.name, t]));
  for (const name of liveSessions) {
    if (!byName.has(name)) byName.set(name, { name, displayName: name });
  }
  sendJsonHttp(res, 200, { tabs: [...byName.values()] });
}

/** Persist a tab's display-name change ({ name, displayName }). */
async function handleRenameSession(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 4096)).toString("utf8"));
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const obj = body as { name?: unknown; displayName?: unknown };
  if (typeof obj?.name !== "string") {
    sendJsonHttp(res, 400, { error: "missing name" });
    return;
  }
  const name = sanitizeSession(obj.name);
  const displayName =
    typeof obj.displayName === "string" ? obj.displayName : name;
  setWebTabLabel(name, displayName);
  sendJsonHttp(res, 200, { ok: true });
}

// Matches the files we generate (clip-<ISO-stamp>-<rand>...), regardless of the
// original name/extension appended after, so pruning only ever touches ours.
const UPLOAD_NAME_RE = /^clip-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-z0-9]/i;

/**
 * Keep the upload directory bounded: delete our `clip-*` files older than
 * uploadRetentionHours, then keep only the newest uploadMaxFiles. Only touches
 * files matching our own naming pattern. Never throws.
 */
async function pruneUploads(): Promise<void> {
  try {
    let names: string[];
    try {
      names = await fsp.readdir(config.uploadDir);
    } catch {
      return; // dir doesn't exist yet — nothing to prune
    }
    const stats: { fp: string; mtime: number }[] = [];
    for (const name of names) {
      if (!UPLOAD_NAME_RE.test(name)) continue;
      const fp = path.join(config.uploadDir, name);
      try {
        const st = await fsp.stat(fp);
        if (st.isFile()) stats.push({ fp, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }

    const now = Date.now();
    const maxAgeMs = config.uploadRetentionHours * 3_600_000;
    const survivors: { fp: string; mtime: number }[] = [];
    for (const s of stats) {
      if (maxAgeMs > 0 && now - s.mtime > maxAgeMs) {
        await fsp.unlink(s.fp).catch(() => {});
      } else {
        survivors.push(s);
      }
    }

    if (config.uploadMaxFiles > 0 && survivors.length > config.uploadMaxFiles) {
      survivors.sort((a, b) => b.mtime - a.mtime); // newest first
      for (const s of survivors.slice(config.uploadMaxFiles)) {
        await fsp.unlink(s.fp).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[upload] prune error:", err);
  }
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  nameParam: string | null
): Promise<void> {
  const ctype = (req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  // Any file type is allowed. Prefer the original (sanitized) filename so the
  // saved file keeps its name and extension; fall back to a content-type ext
  // (mainly for clipboard image pastes, which carry no name), then ".bin".
  const safeName = safeUploadBaseName(nameParam);

  const maxBytes = config.uploadMaxBytes;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (maxBytes > 0 && size > maxBytes) {
        const mb = Math.round(maxBytes / (1024 * 1024));
        sendJsonHttp(res, 413, { error: `file too large (max ${mb} MB)` });
        req.destroy();
        return;
      }
      chunks.push(buf);
    }
  } catch (err) {
    console.error("[upload] read error:", err);
    if (!res.headersSent) sendJsonHttp(res, 400, { error: "read failed" });
    return;
  }

  if (size === 0) {
    sendJsonHttp(res, 400, { error: "empty body" });
    return;
  }

  try {
    await fsp.mkdir(config.uploadDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\..+$/, "")
      .replace("T", "_");
    const rand = Math.random().toString(36).slice(2, 8) || "x";
    const suffix = safeName ? `-${safeName}` : IMAGE_EXT[ctype] ?? ".bin";
    const filename = `clip-${stamp}-${rand}${suffix}`;
    const filePath = path.join(config.uploadDir, filename);
    await fsp.writeFile(filePath, Buffer.concat(chunks), { mode: 0o600 });
    console.log(`[upload] saved ${filePath} (${size} bytes)`);
    sendJsonHttp(res, 200, { path: filePath, name: filename, size });
    void pruneUploads(); // keep the upload dir bounded

  } catch (err) {
    console.error("[upload] write error:", err);
    sendJsonHttp(res, 500, { error: "could not save file" });
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // Wrap in a try/catch so a single bad request never takes down the process.
  void (async () => {
    try {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const requestUrl = new URL(req.url, "http://localhost");
      const method = req.method ?? "GET";

      // Token gate (no-op when AUTH_TOKEN is unset). Handles the login page and
      // the ?token=… sign-in for every route.
      if (gateHttp(req, res, requestUrl, config.authToken)) return;

      if (method === "POST" && requestUrl.pathname === "/upload") {
        await handleUpload(req, res, requestUrl.searchParams.get("name"));
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/sessions") {
        await handleListSessions(res);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/sessions/rename") {
        await handleRenameSession(req, res);
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          Allow: "GET, HEAD",
        });
        res.end("Method Not Allowed");
        return;
      }

      await serveStatic(req, res, requestUrl.pathname);
    } catch (err) {
      console.error("[http] unhandled request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  })();
});

server.on("clientError", (err, socket) => {
  // Malformed HTTP from a client; respond minimally and don't crash.
  console.error("[http] client error:", err.message);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

// ---------------------------------------------------------------------------
// WebSocket terminal bridge
// ---------------------------------------------------------------------------

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const HEARTBEAT_MS = 20_000;

// This server's own configuration env vars. They must NOT leak into the user's
// shell: e.g. zsh's `%m` prompt escape reads $HOST, so an exported HOST (the
// bind address) would make the prompt show "100" instead of the real hostname.
const SERVER_ENV_VARS = ["HOST", "PORT", "DEFAULT_SESSION"];

function hasUtf8(value: string | undefined): boolean {
  return typeof value === "string" && /utf-?8/i.test(value);
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  for (const key of SERVER_ENV_VARS) {
    delete env[key];
  }
  // Ensure a UTF-8 locale. Under launchd the environment has no LANG, which
  // leaves the shell and tmux in a non-UTF-8 (C) locale — CJK/wide characters
  // then render as "_" and multibyte (IME) input is mangled. Only set a default
  // if none of the locale vars already request UTF-8.
  if (!hasUtf8(env.LC_ALL) && !hasUtf8(env.LC_CTYPE) && !hasUtf8(env.LANG)) {
    env.LANG = "en_US.UTF-8";
  }
  return env;
}

interface LiveSocket extends WebSocket {
  isAlive: boolean;
}

const wss = new WebSocketServer({ noServer: true });

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[ws] failed to send json:", err);
    }
  }
}

wss.on("connection", (rawWs: WebSocket, req: http.IncomingMessage) => {
  const ws = rawWs as LiveSocket;
  ws.isAlive = true;

  // Resolve the requested session from the query string.
  let requested: string | null = null;
  try {
    const u = new URL(req.url ?? "/ws", "http://localhost");
    requested = u.searchParams.get("session");
  } catch {
    requested = null;
  }
  const session = sanitizeSession(requested ?? config.defaultSession);

  let proc: pty.IPty;
  try {
    proc = pty.spawn("tmux", tmuxArgs(session, config.tmuxConfPath), {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: os.homedir(),
      env: buildChildEnv(),
    });
  } catch (err) {
    console.error(`[ws] failed to spawn tmux for session "${session}":`, err);
    sendJson(ws, { type: "info", message: "Failed to start terminal session." });
    try {
      ws.close(1011, "spawn failed");
    } catch {
      /* ignore */
    }
    return;
  }

  console.log(`[ws] connected -> tmux session "${session}" (pid ${proc.pid})`);

  // Tag the tmux session as a web tab so every device sees it (cross-device
  // sync), and note it as live so /api/sessions lists it without waiting for
  // the tag write. Tagging on every connect also adopts pre-existing sessions.
  liveSessions.add(session);
  tagWebSession(session);
  addSessionClient(session, ws);

  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    liveSessions.delete(session);
    try {
      // Killing the pty only detaches this tmux client; the server/session
      // persist so the session can be resumed on reconnect.
      proc.kill();
    } catch (err) {
      console.error("[ws] error killing pty:", err);
    }
  };

  // pty output -> ws (binary)
  const onData = proc.onData((data: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      // node-pty emits strings; send raw bytes so xterm gets exact output.
      ws.send(Buffer.from(data, "utf8"), { binary: true });
    } catch (err) {
      console.error("[ws] send error:", err);
    }
  });

  const onExit = proc.onExit(({ exitCode, signal }) => {
    console.log(
      `[ws] pty for "${session}" exited (code ${exitCode}, signal ${signal ?? "none"})`
    );
    closed = true; // pty is already gone; avoid kill() in cleanup
    liveSessions.delete(session);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(1000, "pty exited");
      } catch {
        /* ignore */
      }
    }
  });

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (closed) return;
    try {
      if (isBinary) {
        // Raw user input bytes -> pty.
        const buf = Array.isArray(data)
          ? Buffer.concat(data.map((d) => Buffer.from(d)))
          : Buffer.from(data as ArrayBuffer);
        proc.write(buf.toString("utf8"));
        return;
      }

      // TEXT frame: JSON control message.
      const text = Array.isArray(data)
        ? Buffer.concat(data.map((d) => Buffer.from(d))).toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // ignore non-JSON text frames
      }

      if (!isClientMessage(parsed)) return;

      if (parsed.type === "resize") {
        const cols = Math.max(1, Math.floor(parsed.cols));
        const rows = Math.max(1, Math.floor(parsed.rows));
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          try {
            proc.resize(cols, rows);
          } catch (err) {
            console.error("[ws] resize error:", err);
          }
        }
      } else if (parsed.type === "ping") {
        sendJson(ws, { type: "pong" });
      } else if (parsed.type === "restart") {
        // Kill this session's tmux session. The attached pty (tmux client)
        // then exits, the ws closes, and the client reconnects into a fresh
        // session via `new-session -A`.
        execFile("tmux", ["kill-session", "-t", session], (err) => {
          if (err) {
            console.error(
              `[ws] restart: kill-session "${session}" failed:`,
              err.message
            );
            sendJson(ws, { type: "info", message: "Restart failed." });
          }
        });
      } else if (parsed.type === "kill") {
        // Close-tab: kill the session for good (nothing is recreated). Killing
        // the tmux session drops its @twtab tag with it, so the tab disappears
        // from every device's list automatically. Tell the other devices first
        // (before the kill drops their sockets) so they remove the tab instead
        // of auto-reconnecting and recreating the session.
        broadcastClosed(session, ws);
        liveSessions.delete(session);
        execFile("tmux", ["kill-session", "-t", session], (err) => {
          if (err) {
            console.error(
              `[ws] kill: kill-session "${session}" failed:`,
              err.message
            );
          }
        });
      } else if (parsed.type === "debug") {
        console.error(
          `[ime-debug] session=${session} event=${parsed.event} ` +
            `data=${JSON.stringify(parsed.data ?? "")} at=${parsed.at ?? ""}`
        );
      }
    } catch (err) {
      console.error("[ws] message handler error:", err);
    }
  });

  // Heartbeat bookkeeping (protocol-level pong).
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("error", (err) => {
    console.error(`[ws] socket error (session "${session}"):`, err);
  });

  ws.on("close", () => {
    onData.dispose();
    onExit.dispose();
    removeSessionClient(session, ws);
    cleanup();
    console.log(`[ws] disconnected from "${session}" (tmux session persists)`);
  });
});

wss.on("error", (err) => {
  console.error("[wss] server error:", err);
});

// Upgrade only on the /ws path; reject everything else.
server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // The terminal stream is the sensitive part: reject the upgrade unless the
  // request carries the auth cookie (the browser sends it automatically once
  // signed in). No-op when AUTH_TOKEN is unset.
  if (!isAuthed(req, config.authToken)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Heartbeat: terminate sockets that stopped responding to pings.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as LiveSocket;
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// ---------------------------------------------------------------------------
// Startup & graceful shutdown
// ---------------------------------------------------------------------------

function logStartup(): void {
  const port = config.port;
  const displayHost = config.host === "0.0.0.0" ? "localhost" : config.host;

  console.log("");
  console.log("  terminal-web is running.");
  console.log(`  Local:     http://${displayHost}:${port}/`);

  if (config.tailscaleIp) {
    console.log(`  Tailscale: http://${config.tailscaleIp}:${port}/   <-- share this`);
  } else {
    console.log(
      "  Tailscale: (not detected — install/start tailscale or set HOST to your tailnet IP)"
    );
  }

  if (!ensureTmuxAvailable()) {
    console.warn(
      "  WARNING: tmux was not found on PATH. Sessions will fail to start. Install tmux (e.g. `brew install tmux`)."
    );
  }
  console.log(`  Default session: "${config.defaultSession}"  (override with ?session=NAME)`);
  console.log("");
}

server.listen(config.port, config.host, () => {
  logStartup();
  void pruneUploads(); // tidy old uploads on boot
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[server] port ${config.port} on ${config.host} is already in use. ` +
        "Set PORT to a free port or stop the other process."
    );
  } else if (err.code === "EADDRNOTAVAIL") {
    console.error(
      `[server] cannot bind to host ${config.host} (address not available). ` +
        "Is Tailscale up? You can set HOST=0.0.0.0 to bind all interfaces."
    );
  } else {
    console.error("[server] error:", err);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] received ${signal}, shutting down...`);

  clearInterval(heartbeat);

  // Close all websockets (detaches their tmux clients; sessions persist).
  for (const client of wss.clients) {
    try {
      client.close(1001, "server shutting down");
    } catch {
      /* ignore */
    }
  }

  wss.close(() => {
    server.close(() => {
      console.log("[server] closed. Goodbye.");
      process.exit(0);
    });
  });

  // Force exit if something hangs.
  setTimeout(() => {
    console.warn("[server] forced exit after timeout.");
    process.exit(0);
  }, 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Last-resort guards so one stray error never kills the whole server.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});
