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
} from "./tmux.js";
import type { ServerMessage } from "./types.js";
import { isClientMessage } from "./types.js";

const config = loadConfig();

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

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
// Image upload (POST /upload): save a pasted/dropped image to a file so the
// program in the terminal (e.g. Claude Code) can read it by path. The client
// sends the raw image bytes as the body with the image's Content-Type.
// ---------------------------------------------------------------------------
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

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

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const ctype = (req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext = IMAGE_EXT[ctype];
  if (!ext) {
    sendJsonHttp(res, 415, { error: `unsupported content-type: ${ctype}` });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_UPLOAD_BYTES) {
        sendJsonHttp(res, 413, { error: "file too large (max 25 MB)" });
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
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `clip-${stamp}-${rand}${ext}`;
    const filePath = path.join(config.uploadDir, filename);
    await fsp.writeFile(filePath, Buffer.concat(chunks), { mode: 0o600 });
    console.log(`[upload] saved ${filePath} (${size} bytes)`);
    sendJsonHttp(res, 200, { path: filePath, name: filename, size });
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

      if (method === "POST" && requestUrl.pathname === "/upload") {
        await handleUpload(req, res);
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

  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
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
