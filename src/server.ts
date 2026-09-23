import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
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
  listTmuxSessions,
  applyLayout,
  readLayout,
  sessionAgeSeconds,
  findClientTty,
  refreshClient,
} from "./tmux.js";
import type { WindowLayout } from "./tmux.js";
import type { ServerMessage } from "./types.js";
import { isClientMessage } from "./types.js";
import { gateHttp, isAuthed } from "./auth.js";

const config = loadConfig();

// The cross-device tab list lives on the tmux sessions themselves (a @twtab
// user option), so it can't drift from reality — see tmux.ts. This set just
// tracks sessions with a live WebSocket right now, so a freshly-connected tab
// shows up in /api/sessions immediately, before its tag write has landed.
const liveSessions = new Set<string>();

// Every pty currently alive (one per attached WebSocket). Its size is capped at
// config.maxPtys before we ever spawn another tmux client, so a runaway or
// rapidly-reconnecting client can't exhaust the host's small system-wide pty
// table (macOS kern.tty.ptmx_max is only ~511) and lock everything — including
// new SSH logins — out of allocating a terminal.
const livePtys = new Set<pty.IPty>();

// node-pty 1.1.0 leaked ~3 fds per spawn on macOS (an untracked "twin" /dev/ptmx
// master, the slave /dev/ttysN, and a kqueue) — destroy() closed only the
// tracked master, so reconnect churn once crept toward macOS's ~511 pty cap and
// locked SSH out (the 2026-06-13 incident). We used to reap the twin ourselves
// at spawn. node-pty 1.2.0-beta.14 closes all of them on teardown (verified: a
// spawn→kill→destroy loop leaks ~0.03 fds vs 1.1.0's ~3), so the reaper is gone
// and plain pty.spawn() is used below. The pty-fd watchdog still backstops any
// future regression.

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

/**
 * Tell every client of `name` that the session was closed, so its tab goes away
 * on every device instead of being recreated by a reconnect. `except` skips the
 * socket that asked, where there is one — closing over HTTP has none.
 */
function broadcastClosed(name: string, except?: WebSocket): void {
  const set = sessionClients.get(name);
  if (!set) return;
  for (const peer of set) {
    if (peer !== except) sendJson(peer, { type: "closed" });
  }
}

/**
 * Tell every client of `name` — this device included — which of the tab's two
 * panes is on screen, so the control always shows what tmux is actually doing
 * and a switch made on one device lands on the others too.
 */
function broadcastLayout(name: string, state: WindowLayout): void {
  const set = sessionClients.get(name);
  if (!set) return;
  for (const peer of set) {
    sendJson(peer, {
      type: "layout",
      mode: state.mode,
      panes: state.panes,
      divider: state.divider,
    });
  }
}

// Sessions whose second pane is being created right now, so two devices
// attaching to the same brand-new session can't both split it.
const splitting = new Set<string>();

// A session younger than this was created by the connection that is asking, so
// nothing is running in it yet and its second pane is free to make. Anything
// older keeps whatever layout it has until the user asks for a change.
const FRESH_SESSION_SECONDS = 10;

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
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
const PWA_ASSETS = new Set([
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
]);

function resolveStaticPath(pathname: string): string | null {
  let rel: string | null = null;

  if (pathname === "/" || pathname === "/index.html") {
    rel = "index.html";
  } else if (pathname === "/styles.css") {
    rel = "styles.css";
  } else if (PWA_ASSETS.has(pathname)) {
    // PWA manifest + icons live at the web root.
    rel = pathname.slice(1);
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
 * A short token identifying the currently built client bundle, from the size +
 * mtime of the files in public/dist. Stamped onto their URLs in index.html so a
 * rebuild produces URLs nothing can have cached.
 *
 * We send Cache-Control: no-cache on every static response, but Cloudflare
 * rewrites that to its Browser Cache TTL — measured at max-age=14400 — for
 * requests through the public hostname. A browser that has terminal.js pinned
 * for four hours then keeps running the old client across deploys, silently:
 * a plain reload never asks the server, the WebSocket reconnects fine, and only
 * a hard refresh escapes. Direct tailnet access is unaffected, which is exactly
 * what makes it easy to miss. The URL changing on each build sidesteps all of
 * it — for the edge cache and the browser cache alike — without depending on
 * any Cloudflare setting. index.html itself is served no-cache and comes back
 * DYNAMIC (uncached) through Cloudflare, so the fresh stamp always arrives.
 */
async function bundleVersion(): Promise<string> {
  try {
    const parts = await Promise.all(
      ["terminal.js", "terminal.css"].map(async (name) => {
        const st = await fsp.stat(path.join(config.publicDir, "dist", name));
        return `${st.size}-${Math.round(st.mtimeMs)}`;
      })
    );
    return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
  } catch {
    return ""; // dist missing (never built) — leave the URLs untouched
  }
}

/**
 * Serve index.html with the machine's hostname injected into <title>, so each
 * host shows up as a distinct browser tab, and the bundle URLs stamped with the
 * current build. The file is tiny, so reading it per request is fine
 * (responses are no-cache anyway).
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

  const version = await bundleVersion();
  if (version) {
    html = html.replace(
      /(["'])(\/dist\/terminal\.(?:js|css))\1/g,
      (_m, quote: string, url: string) => `${quote}${url}?v=${version}${quote}`
    );
  }

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

/**
 * Re-adopt as web tabs the sessions a device remembers having.
 *
 * The tab list lives on the tmux sessions themselves (@twtab), and that tag is
 * written when a tab attaches. tmux-resurrect brings sessions back after a
 * reboot WITHOUT it, and a tab only attaches when you open it now — so nothing
 * would re-tag the restored ones and the whole list would disappear on the next
 * sync. A device that still remembers them says so here instead.
 *
 * Only sessions that really exist in tmux are tagged, so a tab closed on
 * another device stays closed rather than being resurrected by a stale cache.
 */
async function handleAdoptSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 8192)).toString("utf8"));
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const names = (body as { names?: unknown })?.names;
  if (!Array.isArray(names)) {
    sendJsonHttp(res, 400, { error: "missing names" });
    return;
  }
  const existing = await listTmuxSessions();
  if (!existing) {
    sendJsonHttp(res, 200, { adopted: [] }); // tmux unreachable — say nothing
    return;
  }
  const alive = new Set(existing);
  const adopted: string[] = [];
  for (const raw of names.slice(0, 64)) {
    if (typeof raw !== "string") continue;
    const name = sanitizeSession(raw);
    if (!alive.has(name) || adopted.includes(name)) continue;
    tagWebSession(name);
    adopted.push(name);
  }
  if (adopted.length) {
    console.log(`[api] re-adopted as web tabs: ${adopted.join(", ")}`);
  }
  sendJsonHttp(res, 200, { adopted });
}

/**
 * Close a tab for good: kill its tmux session, with everything running in it.
 *
 * Over HTTP rather than the session's own socket, because a tab need not have
 * one — a tab only attaches when you first look at it, so most of them are
 * sitting there unconnected. The clients that DO have one are told first, so
 * they drop the tab rather than reconnecting into a session `new-session -A`
 * would recreate.
 */
async function handleKillSession(
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
  const obj = body as { name?: unknown };
  if (typeof obj?.name !== "string") {
    sendJsonHttp(res, 400, { error: "missing name" });
    return;
  }
  const name = sanitizeSession(obj.name);
  // Killing a session is the only irreversible thing this server does, so it
  // says so either way. Logging just the failures left no record of what had
  // been killed, which is not what you want when sessions have gone missing.
  console.log(`[api] kill-session "${name}" requested`);
  broadcastClosed(name);
  liveSessions.delete(name);
  execFile("tmux", ["kill-session", "-t", name], (err) => {
    if (err) console.error(`[api] kill-session "${name}" failed:`, err.message);
    else console.log(`[api] kill-session "${name}" done`);
  });
  sendJsonHttp(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// UI prefs (GET/POST /api/prefs). The browser used to be the only place these
// lived, and localStorage is not somewhere they survive: in the iOS launcher
// the terminal runs in a cross-origin iframe whose storage goes away with the
// app, so every relaunch came back at the default font, with the key bar reset
// and the first tab showing instead of the one that was open. They live here
// now, next to the tab list, keyed by device class so a phone's font size is
// not imposed on a desktop. The browser still caches them — this is what fills
// the cache back in.
// ---------------------------------------------------------------------------

const PREFS_FILE = path.join(os.homedir(), ".terminal-web", "prefs.json");

interface UiPrefs {
  /** Tab (tmux session) this device class last had focused. */
  activeTab?: string;
  /** Terminal font size in px. */
  fontSize?: number;
  /** Whether the on-screen key bar is shown. */
  keybar?: boolean;
}

/** device class ("touch" | "desktop") -> that class's prefs. */
type PrefsByScope = Record<string, UiPrefs>;

let prefsCache: PrefsByScope | null = null;
// Writes are chained rather than fired in parallel, so two quick POSTs can't
// race each other into the file with one of them holding stale state.
let prefsWrite: Promise<void> = Promise.resolve();

function prefScope(raw: unknown): string | null {
  return raw === "touch" || raw === "desktop" ? raw : null;
}

async function loadPrefs(): Promise<PrefsByScope> {
  if (prefsCache) return prefsCache;
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(PREFS_FILE, "utf8"));
    prefsCache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as PrefsByScope)
        : {};
  } catch {
    prefsCache = {}; // missing or unreadable: prefs are a convenience, not state
  }
  return prefsCache;
}

/** Write via a temp file + rename, so a crash can never truncate the real one. */
async function writePrefs(data: PrefsByScope): Promise<void> {
  await fsp.mkdir(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, PREFS_FILE);
}

async function handleGetPrefs(
  res: http.ServerResponse,
  scopeRaw: string | null
): Promise<void> {
  const scope = prefScope(scopeRaw);
  if (!scope) {
    sendJsonHttp(res, 400, { error: "bad scope" });
    return;
  }
  const all = await loadPrefs();
  sendJsonHttp(res, 200, { prefs: all[scope] ?? {} });
}

/** Merge a partial update into one scope's prefs ({ scope, ...fields }). */
async function handleSetPrefs(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 2048)).toString("utf8"));
  } catch {
    sendJsonHttp(res, 400, { error: "invalid body" });
    return;
  }
  const obj = body as { scope?: unknown } & UiPrefs;
  const scope = prefScope(obj?.scope);
  if (!scope) {
    sendJsonHttp(res, 400, { error: "bad scope" });
    return;
  }
  const all = await loadPrefs();
  const next: UiPrefs = { ...(all[scope] ?? {}) };
  // Only the fields actually present change; everything else is left alone, so
  // a client that knows about one pref can't blank the ones it doesn't.
  if (typeof obj.activeTab === "string" && obj.activeTab.trim()) {
    next.activeTab = sanitizeSession(obj.activeTab);
  }
  if (typeof obj.fontSize === "number" && Number.isFinite(obj.fontSize)) {
    next.fontSize = Math.min(28, Math.max(8, Math.round(obj.fontSize)));
  }
  if (typeof obj.keybar === "boolean") next.keybar = obj.keybar;
  all[scope] = next;
  prefsCache = all;
  prefsWrite = prefsWrite
    .then(() => writePrefs(all))
    .catch((err: Error) => {
      console.error("[prefs] write failed:", err.message);
    });
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
// File download (GET/HEAD /api/download?path=…): stream a file from the host
// back to the browser as an attachment — the reverse of /upload. It will read
// any file the server's user can read, but that is NOT a wider trust boundary
// than we already expose: the terminal itself grants full shell access behind
// the SAME auth gate (a client who can attach a session can already
// `base64 afile` and copy it out). gateHttp() runs before this handler, so the
// same tw_auth cookie / Cloudflare-token rules apply. A leading `~` expands to
// the server user's home; a bare relative path is resolved against it.
// ---------------------------------------------------------------------------
/** The active pane's working directory for a tmux session, or null if unknown. */
function sessionCwd(session: string | null): Promise<string | null> {
  if (!session) return Promise.resolve(null);
  const name = sanitizeSession(session);
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["display-message", "-p", "-t", name, "-F", "#{pane_current_path}"],
      (err, stdout) => resolve(err ? null : stdout.toString().trim() || null)
    );
  });
}

async function handleDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathParam: string | null,
  sessionParam: string | null
): Promise<void> {
  const raw = (pathParam ?? "").trim();
  if (!raw) {
    sendJsonHttp(res, 400, { error: "missing ?path" });
    return;
  }
  let abs: string;
  if (raw === "~" || raw.startsWith("~/")) {
    abs = path.resolve(path.join(os.homedir(), raw.slice(1)));
  } else if (path.isAbsolute(raw)) {
    abs = path.resolve(raw);
  } else {
    // A bare name / relative path resolves against the tmux session's current
    // working directory, so you can download from wherever you are in the
    // terminal without typing an absolute path. Falls back to $HOME.
    const cwd = await sessionCwd(sessionParam);
    abs = path.resolve(cwd ?? os.homedir(), raw);
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs); // follows symlinks
  } catch {
    sendJsonHttp(res, 404, { error: "not found" });
    return;
  }
  if (!stat.isFile()) {
    sendJsonHttp(res, 400, { error: "not a regular file" });
    return;
  }

  const base = path.basename(abs);
  // RFC 6266: an ASCII-only fallback plus a UTF-8 filename* so names with
  // non-ASCII characters (or quotes/backslashes) still download with the right
  // name instead of a mojibake or a broken header.
  const asciiName = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.writeHead(200, {
    "Content-Type": "application/octet-stream", // force a download, not a preview
    "Content-Length": stat.size,
    "Content-Disposition":
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs);
  stream.on("error", (err) => {
    console.error(`[download] read error for ${abs}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end();
  });
  stream.pipe(res);
  console.log(`[download] served ${abs} (${stat.size} bytes)`);
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

      if (method === "POST" && requestUrl.pathname === "/api/sessions/kill") {
        await handleKillSession(req, res);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/sessions/adopt") {
        await handleAdoptSessions(req, res);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/prefs") {
        await handleGetPrefs(res, requestUrl.searchParams.get("scope"));
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/prefs") {
        await handleSetPrefs(req, res);
        return;
      }

      if (
        (method === "GET" || method === "HEAD") &&
        requestUrl.pathname === "/api/download"
      ) {
        await handleDownload(
          req,
          res,
          requestUrl.searchParams.get("path"),
          requestUrl.searchParams.get("session")
        );
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

// Node caps a whole request (body included) at requestTimeout — default 300s.
// A large file upload over a slow/relayed mobile link easily exceeds 5 min and
// was being cut off mid-transfer ("uploaded halfway then dropped"). Disable it:
// the total bytes per request are already bounded by uploadMaxBytes, and
// headersTimeout still guards the header phase against slow-loris. server.timeout
// (socket inactivity) is 0/off by default, so nothing else caps a slow upload.
server.requestTimeout = 0;

// ---------------------------------------------------------------------------
// WebSocket terminal bridge
// ---------------------------------------------------------------------------

// Only a fallback for a client that doesn't state its size: every terminal-web
// client sends the size it will actually use as ?cols=&rows= (see below).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Sanity bounds on a client-supplied size. The low end matters: tmux sizes a
// window to its most recently used client, so one client attaching at a silly
// size resizes the window for everyone else on that session — and a program on
// the alternate screen (Claude Code) has no scrollback, so everything that no
// longer fits is destroyed rather than scrolled off.
const MIN_DIM = 10;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
// At or above this width a split view goes side by side; below it, stacked —
// half of 80 columns is not a terminal anyone can use.
const WIDE_COLS = 100;
// How long after the last resize (or split-view switch) to make tmux repaint.
// Long enough that dragging a window costs one repaint rather than sixty.
const REPAINT_DELAY_MS = 400;
const HEARTBEAT_MS = 20_000;

/** Parse a ?cols=/?rows= param, falling back when absent or out of bounds. */
function parseDim(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < MIN_DIM || n > max) return fallback;
  return n;
}

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

// ---------------------------------------------------------------------------
// Noticing that the tmux server has died.
//
// A tmux client exits 1 the moment its server disappears, so a burst of ptys
// exiting that way is not a dozen sessions closing — it is the whole tmux
// server going down, taking every session's contents with it. That happened on
// the NUC and left no trace beyond a scattering of "pty exited (code 1)" lines
// that had to be read backwards to work out what they meant. One line instead.
// ---------------------------------------------------------------------------
const SERVER_DEATH_WINDOW_MS = 3000;
const SERVER_DEATH_MIN_EXITS = 3;
let abnormalExits: number[] = [];
let lastDeathReport = 0;

function noteAbnormalPtyExit(): void {
  const now = Date.now();
  abnormalExits = abnormalExits.filter((at) => now - at < SERVER_DEATH_WINDOW_MS);
  abnormalExits.push(now);
  if (abnormalExits.length < SERVER_DEATH_MIN_EXITS) return;
  if (now - lastDeathReport < SERVER_DEATH_WINDOW_MS) return; // one line per event
  lastDeathReport = now;
  const count = abnormalExits.length;
  void listTmuxSessions().then((names) => {
    if (names === null) {
      console.error(
        `[tmux] THE TMUX SERVER IS GONE — ${count} clients exited at once and ` +
          "no server is answering. Every session's contents are lost; what " +
          `survives is the last snapshot in ${RESURRECT_DIR}.`
      );
    } else {
      console.error(
        `[tmux] ${count} tmux clients exited at once. A server is answering ` +
          `again with ${names.length} session(s) — if they are empty, the old ` +
          "one died and these are new."
      );
    }
  });
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

  // Resolve the requested session — and the size to attach at — from the query
  // string. Spawning at the client's real size rather than 80x24 keeps the tmux
  // window steady: it used to shrink to 80x24 on every connect and reconnect,
  // for a beat, for every client attached to that session.
  let requested: string | null = null;
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  try {
    const u = new URL(req.url ?? "/ws", "http://localhost");
    requested = u.searchParams.get("session");
    cols = parseDim(u.searchParams.get("cols"), DEFAULT_COLS, MAX_COLS);
    rows = parseDim(u.searchParams.get("rows"), DEFAULT_ROWS, MAX_ROWS);
  } catch {
    requested = null;
  }
  const session = sanitizeSession(requested ?? config.defaultSession);

  // Guard the host's system-wide pty table: refuse the connection (before
  // spawning any pty) once we're at the cap, rather than letting a runaway or
  // flapping client pile up ptys until macOS can't allocate one for SSH either.
  if (livePtys.size >= config.maxPtys) {
    console.warn(
      `[ws] pty cap reached (${livePtys.size}/${config.maxPtys}); refusing "${session}". ` +
        "Close unused tabs, or raise MAX_PTYS."
    );
    sendJson(ws, {
      type: "info",
      message: `Server is at its terminal limit (${config.maxPtys}). Close an unused tab and reconnect.`,
    });
    try {
      ws.close(1013, "pty cap reached");
    } catch {
      /* ignore */
    }
    return;
  }

  let proc: pty.IPty;
  try {
    proc = pty.spawn("tmux", tmuxArgs(session, config.tmuxConfPath), {
      name: "xterm-256color",
      cols,
      rows,
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

  livePtys.add(proc);
  console.log(
    `[ws] connected -> tmux session "${session}" (pid ${proc.pid}) ` +
      `[${livePtys.size}/${config.maxPtys} ptys]`
  );

  // Tag the tmux session as a web tab so every device sees it (cross-device
  // sync), and note it as live so /api/sessions lists it without waiting for
  // the tag write. Tagging on every connect also adopts pre-existing sessions.
  liveSessions.add(session);
  tagWebSession(session);
  addSessionClient(session, ws);

  let closed = false;

  // tmux sends only differences, so a browser grid that has drifted from tmux's
  // model of it never gets corrected — that is the pane divider drawn a column
  // or two off on a few rows, and it stays for as long as the page is open (see
  // tmux.ts). The two moments the two can come apart are a resize and a
  // split-view switch, because the divider column itself moves; both schedule a
  // full repaint here. Coalesced, so dragging a window costs one.
  let clientTty: string | null = null;
  let repaintTimer: NodeJS.Timeout | null = null;
  const scheduleRepaint = (): void => {
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (closed) return;
      void (async () => {
        // The tty is stable for the life of this pty, so it is looked up once.
        if (!clientTty) clientTty = await findClientTty(proc.pid);
        if (clientTty && !closed) await refreshClient(clientTty);
        // A resize moves the divider, and the browser clips its selections to
        // it, so hand out the column it ended up at.
        const state = await readLayout(session);
        if (state && !closed) broadcastLayout(session, state);
      })();
    }, REPAINT_DELAY_MS);
  };

  // Tell this client which of the tab's panes is on screen, and give a session
  // we just created its second pane straight away — splitting costs nothing
  // while nothing is running in it, so every tab made from here on has both
  // views available with only the main one shown. A session that already
  // existed is left exactly as it is: splitting a pane that is running
  // something takes rows or columns away from it, and on the alternate screen
  // those are destroyed rather than scrolled off. Those get their second pane
  // the first time the user asks for it. Retried while tmux registers the
  // session, same as tagWebSession.
  const orient: "h" | "v" = cols >= WIDE_COLS ? "h" : "v";
  const reportLayout = async (attempt = 0): Promise<void> => {
    if (closed) return;
    let state = await readLayout(session);
    if (!state) {
      if (attempt < 10) setTimeout(() => void reportLayout(attempt + 1), 150);
      return;
    }
    if (state.panes < 2 && !splitting.has(session)) {
      const age = await sessionAgeSeconds(session);
      if (age !== null && age <= FRESH_SESSION_SECONDS) {
        splitting.add(session);
        try {
          state = (await applyLayout(session, "one", orient, true)) ?? state;
        } finally {
          splitting.delete(session);
        }
        broadcastLayout(session, state);
        return;
      }
    }
    sendJson(ws, {
      type: "layout",
      mode: state.mode,
      panes: state.panes,
      divider: state.divider,
    });
  };
  void reportLayout();

  // xterm.js auto-answers the terminal-identity queries (DA1 ESC[?..c /
  // DA2 ESC[>..c) tmux sends when a client attaches. tmux 3.6 only *consumes*
  // those replies for ~3s after attach; one that arrives later (phone waking
  // up over the tunnel) or a second one (stale query answered post-reconnect)
  // is parsed as keystrokes and lands in the foreground program's input as
  // literal "?1;2c" — regardless of escape-time. Let each kind through once,
  // early; strip the rest. OSC color replies are consumed anytime, left alone.
  const DA_WINDOW_MS = 2500;
  const attachedAt = Date.now();
  const daSeen: Record<"?" | ">", boolean> = { "?": false, ">": false };
  const filterDaReplies = (input: string): string => {
    if (!input.includes("\x1b[")) return input;
    return input.replace(/\x1b\[([?>])[0-9;]*c/g, (seq, kind: "?" | ">") => {
      if (!daSeen[kind] && Date.now() - attachedAt <= DA_WINDOW_MS) {
        daSeen[kind] = true;
        return seq;
      }
      console.log(
        `[ws] stripped late/duplicate DA reply for "${session}": ${JSON.stringify(seq)}`
      );
      return "";
    });
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (repaintTimer) {
      clearTimeout(repaintTimer);
      repaintTimer = null;
    }
    liveSessions.delete(session);
    livePtys.delete(proc);
    try {
      // Killing the pty only detaches this tmux client; the server/session
      // persist so the session can be resumed on reconnect.
      proc.kill();
    } catch (err) {
      console.error("[ws] error killing pty:", err);
    }
    // kill() only signals the child — node-pty closes the TRACKED master fd
    // (proc.fd) when its ReadStream reaches EOF, but ws.on("close") disposes
    // onData first, pausing that stream, so the close can lag. destroy() force-
    // closes it (and, on node-pty 1.2, the slave + kqueue) promptly. IPty's
    // public typing omits destroy(); the runtime UnixTerminal has it.
    try {
      (proc as unknown as { destroy?: () => void }).destroy?.();
    } catch (err) {
      console.error("[ws] error destroying pty:", err);
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
    // Exit 1 with no signal is what a tmux client does when its server goes.
    if (exitCode === 1 && !signal) noteAbnormalPtyExit();
    closed = true; // pty is already gone; avoid kill() in cleanup
    liveSessions.delete(session);
    livePtys.delete(proc);
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
        const input = filterDaReplies(buf.toString("utf8"));
        if (input) proc.write(input);
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
        // Same bounds as the query-string size: a client that asks for a
        // degenerate window would shrink it for every other client on the
        // session, destroying whatever is on the alternate screen.
        const next = {
          cols: parseDim(String(parsed.cols), 0, MAX_COLS),
          rows: parseDim(String(parsed.rows), 0, MAX_ROWS),
        };
        // Clients re-state their size on every reconnect, so most of these
        // messages ask for the size we already have: acting on those would
        // make tmux redraw, and mark this client the "latest" one, for nothing.
        if (next.cols && next.rows && (next.cols !== cols || next.rows !== rows)) {
          cols = next.cols;
          rows = next.rows;
          try {
            proc.resize(cols, rows);
            scheduleRepaint();
          } catch (err) {
            console.error("[ws] resize error:", err);
          }
        }
      } else if (parsed.type === "layout") {
        // Switch which pane is on screen. Never closes one: showing a single
        // pane is tmux's zoom, so the other keeps running out of sight.
        const want = parsed.orient === "v" ? "v" : "h";
        void applyLayout(session, parsed.mode, want).then((state) => {
          if (state) broadcastLayout(session, state);
          scheduleRepaint();
        });
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

// Safety net for pty-fd leaks we can't fix from JS: a failed pty.spawn() can
// orphan a master fd in node-pty's native layer (the throw leaves us no handle
// to close), and we can't rule out other node-pty leaks. The destroy() in
// cleanup() fixes the known disconnect leak, but ANY residual leak must never be
// allowed to creep up to macOS's ~511 system-wide pty cap and lock SSH out
// again (the 2026-06-13 incident). Periodically count THIS process's open pty
// masters (character-device fds) via /dev/fd; if they exceed a ceiling far below
// the system limit but well above maxPtys, log loudly and exit so launchd
// (KeepAlive) restarts us cleanly. The tmux sessions live in a separate server
// process and survive, so clients just reconnect into them.
//
// node-pty 1.2 holds ~2 character-device fds per LIVE pty (the /dev/ptmx master
// plus the slave /dev/ttysN); older builds held more. The ceiling stays at
// 4 * maxPtys (+ a little for stdio) — comfortably above the real footprint at
// capacity, yet still hundreds of fds short of the ~511 system cap, so it trips
// only on a genuine leak.
const PTY_FD_CEILING = config.maxPtys * 4 + 16;

function countOwnPtyFds(): number {
  let fds: string[];
  try {
    fds = fs.readdirSync("/dev/fd");
  } catch {
    return 0; // not introspectable here (non-macOS / sandbox) — skip the check
  }
  let n = 0;
  for (const entry of fds) {
    const fd = Number(entry);
    if (!Number.isInteger(fd)) continue;
    try {
      if (fs.fstatSync(fd).isCharacterDevice()) n++;
    } catch {
      /* fd vanished or not stat-able (kqueue, listening socket) — ignore */
    }
  }
  return n;
}

const ptyLeakWatchdog = setInterval(() => {
  const ptyFds = countOwnPtyFds();
  if (ptyFds > PTY_FD_CEILING) {
    console.error(
      `[watchdog] open pty fds (${ptyFds}) exceeded ceiling ${PTY_FD_CEILING} ` +
        `(live ptys ${livePtys.size}/${config.maxPtys}) — a pty fd leak is ` +
        "filling the system pty table; exiting so launchd restarts cleanly " +
        "(tmux sessions persist)."
    );
    process.exit(1);
  }
}, HEARTBEAT_MS);
ptyLeakWatchdog.unref();

// ---------------------------------------------------------------------------
// Session snapshots.
//
// tmux/web.tmux.conf loads tmux-resurrect and tmux-continuum so a snapshot is
// taken every 15 minutes and a dead tmux server costs nothing. That has never
// actually happened: continuum drives its save off the status line being
// redrawn, and this config hides the status line (`set -g status off`) for an
// edge-to-edge terminal, so the hook it installs is never evaluated. Both
// plugins were installed, enabled, and silently doing nothing — when a tmux
// server died on the NUC the newest snapshot turned out to be ten weeks old,
// which made the loss total.
//
// So the save runs from here, where it depends on nothing being drawn. This
// service is already running on every machine that has the sessions.
// ---------------------------------------------------------------------------
const SNAPSHOT_MS = 5 * 60_000;
// The first one is early: a machine that has just come up should have a recent
// snapshot without waiting out a full interval.
const FIRST_SNAPSHOT_MS = 90_000;
const RESURRECT_DIR = path.join(os.homedir(), ".local/share/tmux/resurrect");
const RESURRECT_SAVE = path.join(
  os.homedir(),
  ".tmux/plugins/tmux-resurrect/scripts/save.sh"
);

/**
 * Count the pane lines in the snapshot resurrect just wrote, so the log can
 * say what was really saved rather than that the script exited 0.
 *
 * The first version of this saved a 20-byte file holding "state_terminal-web_"
 * and nothing else, and reported success. resurrect's format is tab-separated,
 * and tmux rewrites control characters in -F output to "_" unless the locale
 * is UTF-8 — which the bare environment a service gets is not. Every field
 * merged into one, every pane was dropped, and the `last` symlink moved to
 * point at the result. Hence the UTF-8 environment below, and this check: a
 * snapshot nobody has verified is how we got here.
 */
async function readSnapshot(): Promise<{ panes: number; sessions: number; ageMs: number } | null> {
  const file = path.join(RESURRECT_DIR, "last");
  try {
    const [text, stat] = await Promise.all([
      fsp.readFile(file, "utf8"),
      fsp.stat(file),
    ]);
    const lines = text.split("\n").filter((line) => line.startsWith("pane\t"));
    const sessions = new Set(lines.map((line) => line.split("\t")[1]));
    return { panes: lines.length, sessions: sessions.size, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

// A snapshot taken right after a disaster overwrites the one taken before it,
// and `last` is what continuum restores from on the next boot. So a sudden
// collapse in the number of sessions is treated as "something just went very
// wrong" and the save is skipped, loudly, rather than writing over the only
// record of what was there. Bounded in time: once the smaller set has been the
// truth for this long, it IS the truth and snapshots resume.
const COLLAPSE_GRACE_MS = 2 * 60 * 60_000;

async function snapshotSessions(): Promise<void> {
  try {
    await fsp.access(RESURRECT_SAVE, fs.constants.X_OK);
  } catch {
    return; // resurrect isn't installed here — nothing to do
  }
  // Never snapshot an empty tmux: that would overwrite the last good one with
  // nothing, which is exactly the moment a snapshot is worth having.
  const names = await listTmuxSessions();
  if (!names || names.length === 0) return;
  const previous = await readSnapshot();
  if (
    previous &&
    previous.ageMs < COLLAPSE_GRACE_MS &&
    previous.sessions >= 2 &&
    names.length * 2 <= previous.sessions
  ) {
    console.error(
      `[snapshot] NOT saving: ${names.length} session(s) live but the last ` +
        `snapshot holds ${previous.sessions} — keeping it rather than writing ` +
        "over the only record of what was there. Restore from " +
        `${RESURRECT_DIR} if this was not deliberate.`
    );
    return;
  }
  // buildChildEnv for the locale: resurrect's format is tab-separated and tmux
  // only emits real tabs under a UTF-8 locale (see readSnapshot).
  execFile(RESURRECT_SAVE, ["quiet"], { env: buildChildEnv() }, (err) => {
    if (err) {
      console.error("[snapshot] resurrect save failed:", err.message);
      return;
    }
    void readSnapshot().then((snap) => {
      const panes = snap?.panes ?? null;
      if (panes === null) {
        console.error("[snapshot] saved, but the snapshot could not be read back");
      } else if (panes === 0) {
        console.error(
          `[snapshot] SAVED NOTHING: ${names.length} session(s) live but the ` +
            "snapshot holds no panes — it cannot be restored from"
        );
      } else {
        console.log(`[snapshot] saved ${panes} pane(s) across ${names.length} session(s)`);
      }
    });
  });
}

setTimeout(() => void snapshotSessions(), FIRST_SNAPSHOT_MS).unref();
const snapshotTimer = setInterval(() => void snapshotSessions(), SNAPSHOT_MS);
snapshotTimer.unref();

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
  console.log(`  Max concurrent terminals: ${config.maxPtys}  (set MAX_PTYS to change)`);
  console.log("");
}

server.listen(config.port, config.host, () => {
  logStartup();
  void pruneUploads(); // tidy old uploads on boot
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRNOTAVAIL") {
    // launchd starts us at boot before tailscaled has configured the tailnet IP
    // we bind to, so the first bind fails with EADDRNOTAVAIL. Wait and retry the
    // same bind instead of exiting — exiting made launchd crash-loop us dozens
    // of times until Tailscale finally came up. The original `listen` callback
    // (registered via once('listening')) still fires on the eventual success.
    console.warn(
      `[server] cannot bind to ${config.host}:${config.port} yet ` +
        "(address not available — waiting for Tailscale/interface). Retrying in 3s…"
    );
    setTimeout(() => server.listen(config.port, config.host), 3000);
    return;
  }
  if (err.code === "EADDRINUSE") {
    console.error(
      `[server] port ${config.port} on ${config.host} is already in use. ` +
        "Set PORT to a free port or stop the other process."
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
