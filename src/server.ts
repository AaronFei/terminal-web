import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { URL } from "node:url";
import { pipeline, Transform } from "node:stream";
import type { Duplex } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";

import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

import { loadConfig, CONFIG_ENV_VARS } from "./config.js";
import {
  sessionName,
  sessionTarget,
  tmuxArgs,
  spawnTmuxPty,
  setTmuxSocket,
  runTmuxStatus,
  sessionCwd as tmuxSessionCwd,
  ensureTmuxAvailable,
  tagWebSession,
  setWebTabLabel,
  listWebTabs,
  listTmuxSessions,
  mateStartDir,
  findClientTty,
  refreshClient,
  SingleFlight,
  snapshotCollapsed,
} from "./tmux.js";
import type { WebTab } from "./tmux.js";
import type { ServerMessage } from "./types.js";
import { isClientMessage } from "./types.js";
import { gateHttp, handleAuthApi, refuseUpgrade, hostAllowed, originAllowed } from "./auth.js";
import { initAuthStore } from "./auth-store.js";

const config = loadConfig();
// Before anything can run tmux: from here on every call goes to this socket.
setTmuxSocket(config.tmuxSocket);
// Sign-in sessions and passkeys, read once; requests only use the memory copy.
initAuthStore(config.authToken);

/**
 * The commit this process is running, for GET /api/health: tsx runs the source
 * as it was when the server started, so after a deploy this is what says
 * whether the restart really picked up the new code. Read once, now — the
 * checkout can move on underneath a running server. Null when it can't be
 * told (no git, not a checkout).
 */
function readCommit(): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: config.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
const RUNNING_COMMIT = readCommit();
const STARTED_AT = new Date().toISOString();

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

// The suffix that makes a session the second half of a split (see web/
// terminal.ts, where the pairing is explained). Reserved: a session named this
// way belongs to the tab it is named after and is not one of its own.
const MATE_SUFFIX = "__b";

/** The second session of the pair, for killing both halves together. */
function mateNameOf(name: string): string {
  return name + MATE_SUFFIX;
}

// ---------------------------------------------------------------------------
// Closed tabs. Telling the clients attached to a session that it was closed
// (broadcastClosed) only reaches the ones connected at that moment. A page on a
// device that was asleep — an iPad in a drawer, a phone in a pocket — still has
// the tab, and when it wakes it reconnects every socket it had open. Attaching
// is `new-session -A`, so each of those reconnects quietly created the session
// again, empty, and tagged it as a tab on every device: close a tab here, and
// an hour later it is back.
//
// So the server remembers what was closed, and a connect to one of those names
// that does not say it means to create the session is answered with "closed"
// instead — the same message a connected client gets, so the stale page drops
// the tab the same way. Kept on disk, because a deploy restarts this server and
// a device can sleep for days.
// ---------------------------------------------------------------------------

const CLOSED_FILE = path.join(os.homedir(), ".terminal-web", "closed.json");
/** How long a closed name is refused to a stale page. */
const CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** name -> when it was closed (epoch ms). */
let closedTabs: Map<string, number> = loadClosedTabs();
let closedWrite: Promise<void> = Promise.resolve();

function loadClosedTabs(): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CLOSED_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const now = Date.now();
      return new Map(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === "number" && now - e[1] < CLOSED_TTL_MS
        )
      );
    }
  } catch {
    /* missing or unreadable: nothing remembered */
  }
  return new Map();
}

function saveClosedTabs(): void {
  const data = JSON.stringify(Object.fromEntries(closedTabs), null, 2);
  // Chained, so two quick closes cannot land out of order.
  closedWrite = closedWrite
    .then(async () => {
      await fsp.mkdir(path.dirname(CLOSED_FILE), { recursive: true });
      const tmp = `${CLOSED_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data, "utf8");
      await fsp.rename(tmp, CLOSED_FILE);
    })
    .catch((err: Error) => {
      console.error("[closed] write failed:", err.message);
    });
}

function markClosed(names: string[]): void {
  const now = Date.now();
  for (const n of names) closedTabs.set(n, now);
  saveClosedTabs();
}

/** A tab made on purpose under a closed name: it, and its second half, are open again. */
function clearClosed(name: string): void {
  const base = name.endsWith(MATE_SUFFIX) ? name.slice(0, -MATE_SUFFIX.length) : name;
  let changed = false;
  for (const n of [base, mateNameOf(base)]) changed = closedTabs.delete(n) || changed;
  if (changed) saveClosedTabs();
}

function isClosed(name: string): boolean {
  const at = closedTabs.get(name);
  if (at === undefined) return false;
  if (Date.now() - at < CLOSED_TTL_MS) return true;
  closedTabs.delete(name);
  return false;
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
 * Every asset index.html links to, relative to publicDir — the files whose URLs
 * carry the build stamp. That has to be all of them and not just the bundle:
 * one unstamped file is enough to pair a new client with an old copy of itself,
 * and nothing about the result says so.
 *
 * styles.css was the one left out. It holds the touch-selection handles and the
 * selection action bar, so an iPad partway through a Browser Cache TTL ran the
 * new terminal.js against a stylesheet that had never heard of either: the bar
 * was created and unhidden, then laid out as an unstyled block at the top of
 * the document, behind the fixed terminal. ?debug=sel measured it at 0,0
 * 1210x22 where the rules would have put a small box above the key bar.
 */
const STAMPED_ASSETS = ["dist/terminal.js", "dist/terminal.css", "styles.css"];

/**
 * A short token identifying the currently built client, from the size + mtime
 * of the assets above. Stamped onto their URLs in index.html so a rebuild
 * produces URLs nothing can have cached.
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
async function assetVersion(): Promise<string> {
  try {
    const parts = await Promise.all(
      STAMPED_ASSETS.map(async (rel) => {
        const st = await fsp.stat(path.join(config.publicDir, rel));
        return `${st.size}-${Math.round(st.mtimeMs)}`;
      })
    );
    return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
  } catch {
    return ""; // not built yet — leave the URLs untouched
  }
}

/**
 * Serve index.html with the machine's hostname injected into <title>, so each
 * host shows up as a distinct browser tab, and the asset URLs stamped with the
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

  const version = await assetVersion();
  if (version) {
    // Driven off the same list the stamp is computed from, so an asset added to
    // one can't be missed by the other.
    for (const rel of STAMPED_ASSETS) {
      const href = new RegExp(`(["'])(/${rel.replace(/\./g, "\\.")})\\1`, "g");
      html = html.replace(href, `$1$2?v=${version}$1`);
    }
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

  sendFileBody(res, filePath, "static");
}

/**
 * Stream a file as the body of a response whose headers are already out.
 *
 * Through pipeline rather than .pipe(): .pipe() does nothing when the response
 * goes away early, so a download cancelled halfway — or a page closed while
 * its bundle was loading — left the read stream paused and its fd open for
 * good. pipeline tears both ends down when either one fails or closes. A read
 * error past this point can't be answered with a status of its own, as the
 * 200 is already sent: the response is cut off instead, and the client sees a
 * body shorter than its Content-Length.
 */
function sendFileBody(res: http.ServerResponse, filePath: string, tag: string): void {
  pipeline(fs.createReadStream(filePath), res, (err) => {
    // The client leaving early is routine, not an error worth a log line.
    if (!err || (err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") return;
    console.error(`[${tag}] read error for ${filePath}:`, err);
  });
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

function sendForbidden(res: http.ServerResponse, why: string): void {
  res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${why}\n`);
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

// Every page asks for the tab list when it loads and on every reconnect, so a
// deploy — which drops every socket on every device at once — had each of them
// fork a `tmux list-sessions` of its own. Requests within WEB_TABS_TTL_MS of
// each other share one; a list still being fetched is shared too.
//
// Anything this server does that changes the list (a tab adopted, killed or
// renamed) drops the cached one, so the page that did it never gets the list
// from before; a tab just opened is in it through liveSessions, which is read
// fresh every time. Only changes made elsewhere — a session ended from a shell
// nobody here is attached to — can take up to the TTL to show.
const WEB_TABS_TTL_MS = 1000;
let webTabsCache: { at: number; tabs: Promise<WebTab[] | null>; settled: WebTab[] | null } | null =
  null;

function cachedWebTabs(): Promise<WebTab[] | null> {
  const now = Date.now();
  if (webTabsCache && now - webTabsCache.at < WEB_TABS_TTL_MS) return webTabsCache.tabs;
  const entry = { at: now, tabs: listWebTabs(), settled: null as WebTab[] | null };
  void entry.tabs.then((tabs) => {
    entry.settled = tabs;
  });
  webTabsCache = entry;
  return entry.tabs;
}

function invalidateWebTabs(): void {
  webTabsCache = null;
}

/**
 * Whether a fresh tab list (see cachedWebTabs) already shows `name` as a tab,
 * so attaching to it need not write the tag again. Only a list that has come
 * back and is still inside the TTL counts; anything else says no, and the tag
 * is written as it always was.
 */
function knownTagged(name: string): boolean {
  const c = webTabsCache;
  if (!c || !c.settled || Date.now() - c.at >= WEB_TABS_TTL_MS) return false;
  return c.settled.some((t) => t.name === name);
}

/**
 * Tag a session as a web tab, and drop the cached list once it is. For tabs
 * that may have no socket (adopt), so are not covered by liveSessions: those
 * only show up in the list through their tag.
 */
function tagAsWebTab(name: string): void {
  tagWebSession(name, invalidateWebTabs);
}

/**
 * Return the web tabs, sourced from tmux (sessions carrying the @twtab tag),
 * unioned with sessions that have a live WebSocket right now (covering the
 * brief window between a tab connecting and its tag write completing). When
 * tmux can't be queried, reply with `tabs: null` so the client keeps its
 * current tabs instead of wrongly clearing them.
 */
async function handleListSessions(res: http.ServerResponse): Promise<void> {
  const tagged = await cachedWebTabs();
  if (tagged === null) {
    sendJsonHttp(res, 200, { tabs: null }); // unknown -> client keeps its state
    return;
  }
  const byName = new Map(tagged.map((t) => [t.name, t]));
  for (const name of liveSessions) {
    if (!byName.has(name)) byName.set(name, { name, displayName: name });
  }
  // The second half of a split is not a tab — it belongs to the one it is named
  // after. Only while that one is here, though: a second half whose first is
  // gone answers to nobody, and hiding it would strand whatever is running in
  // it with no way to reach it.
  for (const name of [...byName.keys()]) {
    if (name.endsWith(MATE_SUFFIX) && byName.has(name.slice(0, -MATE_SUFFIX.length))) {
      byName.delete(name);
    }
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
  // Exactly the name sent, or nothing: a cleaned-up name could label (or, in
  // the kill below, destroy) a session the caller never named.
  const name = sessionName(obj.name);
  if (!name) {
    sendJsonHttp(res, 400, { error: "invalid name" });
    return;
  }
  const displayName =
    typeof obj.displayName === "string" ? obj.displayName : name;
  // The cached list goes now and again once tmux has the label: a list fetched
  // in between may still hold the old one.
  invalidateWebTabs();
  setWebTabLabel(name, displayName, invalidateWebTabs);
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
  // Every name must be one as sent. The client only ever sends valid ones, so
  // a bad one means something is wrong with the request, not just that entry.
  const wanted: string[] = [];
  for (const raw of names.slice(0, 64)) {
    const name = sessionName(raw);
    if (!name) {
      sendJsonHttp(res, 400, { error: "invalid name" });
      return;
    }
    wanted.push(name);
  }
  const existing = await listTmuxSessions();
  if (!existing) {
    sendJsonHttp(res, 200, { adopted: [] }); // tmux unreachable — say nothing
    return;
  }
  const alive = new Set(existing);
  const adopted: string[] = [];
  for (const name of wanted) {
    // A second half is never adopted as a tab of its own; its tab carries it.
    if (name.endsWith(MATE_SUFFIX)) continue;
    if (!alive.has(name) || adopted.includes(name)) continue;
    tagAsWebTab(name);
    adopted.push(name);
  }
  if (adopted.length) {
    console.log(`[api] re-adopted as web tabs: ${adopted.join(", ")}`);
  }
  sendJsonHttp(res, 200, { adopted });
}

/**
 * Kill a session on purpose — a tab closed, a session restarted — and resolve
 * tmux's error (null on success). Callers take their snapshot first (see
 * snapshotBeforeKill). A kill that worked is noted for the collapse guard, so
 * the sessions it removed don't read as a crash; one that failed is not, as
 * that is also how a kill that took the tmux server down with it looks.
 */
async function killSession(name: string): Promise<Error | null> {
  const err = await runTmuxStatus(["kill-session", "-t", sessionTarget(name)]);
  if (!err) noteDeliberateKill(name);
  invalidateWebTabs();
  return err;
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
  // The one irreversible thing this server does, so the name must be exactly
  // the one sent. Cleaning it up instead killed sessions nobody asked about:
  // "x y" became "xy", and an empty or all-symbol name became "web".
  const name = sessionName(obj.name);
  if (!name) {
    sendJsonHttp(res, 400, { error: "invalid name" });
    return;
  }
  // A tab is up to two sessions — its own and, if it was ever split, the one
  // named after it. Closing the tab closes both; nothing else is touched, and
  // the second name is derived here rather than taken from the request, so a
  // caller cannot name a session of its own to take down with it. A first half
  // too long to have a second (over 64 with the suffix) simply has none: no
  // session by that name can exist, since the server refuses to make one.
  const mate = mateNameOf(name);
  const names = name.endsWith(MATE_SUFFIX) || !sessionName(mate) ? [name] : [name, mate];
  for (const target of names) {
    // Killing a session is the only irreversible thing this server does, so it
    // says so either way. Logging just the failures left no record of what had
    // been killed, which is not what you want when sessions have gone missing.
    console.log(`[api] kill-session "${target}" requested`);
    broadcastClosed(target);
    liveSessions.delete(target);
  }
  // Before anything that waits: a sleeping page could wake in the meantime.
  markClosed(names);
  // Save first, and wait for it: this command has taken whole tmux servers down
  // with it (see snapshotBeforeKill). The tab is already gone in the browser —
  // it does not wait on this reply — so the second or two costs nothing. One
  // save covers both halves.
  await snapshotBeforeKill(name);
  for (const target of names) {
    void killSession(target).then((err) => {
      // A tab that was never split has no second session, and "can't find
      // session" is the expected answer for it rather than a failure.
      if (err) console.error(`[api] kill-session "${target}" failed:`, err.message);
      else console.log(`[api] kill-session "${target}" done`);
    });
  }
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
  // A name that isn't one exactly is ignored, not cleaned up into another tab.
  const activeTab = sessionName(obj.activeTab);
  if (activeTab) next.activeTab = activeTab;
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
  const suffix = safeName ? `-${safeName}` : IMAGE_EXT[ctype] ?? ".bin";

  const maxBytes = config.uploadMaxBytes;
  const tooLarge = (): void => {
    const mb = Math.round(maxBytes / (1024 * 1024));
    sendJsonHttp(res, 413, { error: `file too large (max ${mb} MB)` });
  };

  // A body that says up front it is too big is refused before any file is made.
  const declared = Number(req.headers["content-length"]);
  if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
    tooLarge();
    req.destroy();
    return;
  }

  let file: { handle: fsp.FileHandle; filePath: string; filename: string };
  try {
    await fsp.mkdir(config.uploadDir, { recursive: true });
    file = await createUploadFile(suffix);
  } catch (err) {
    console.error("[upload] write error:", err);
    sendJsonHttp(res, 500, { error: "could not save file" });
    req.destroy();
    return;
  }
  const { handle, filePath, filename } = file;

  // Straight to disk as it arrives. This used to collect the whole body in
  // memory and write it at the end — with the 1 GB default limit that peaked
  // at twice the file, and two large uploads at once could take the NUC down.
  //
  // pipeline destroys the request on any failure, and that closes the socket,
  // so an answer has to be written before it does: the 413 from inside the
  // counter, the 500 from an error listener added ahead of pipeline's own.
  let size = 0;
  let failed: "too large" | "write" | null = null;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        failed = "too large";
        tooLarge();
        cb(new Error("upload over the size limit"));
        return;
      }
      cb(null, chunk);
    },
  });
  const out = handle.createWriteStream();
  out.once("error", (err) => {
    // pipeline hands a broken-off request's error on to this stream too; that
    // one is not a write failure, and the request is already gone by then.
    if (failed || req.destroyed) return;
    failed = "write";
    console.error("[upload] write error:", err);
    if (!res.headersSent) sendJsonHttp(res, 500, { error: "could not save file" });
  });

  try {
    await pipelineAsync(req, counter, out);
  } catch (err) {
    // Whatever went wrong, a partial file is never left behind: it would look
    // like a finished upload to anything that went looking.
    await fsp.unlink(filePath).catch(() => {});
    if (failed === "too large") {
      console.warn(`[upload] refused ${filename}: over ${maxBytes} bytes; partial file removed`);
    } else if (!failed) {
      // The client went away, or the request broke off.
      console.warn(
        `[upload] ${filename} broke off after ${size} bytes (${(err as Error).message}); ` +
          "partial file removed"
      );
      if (!res.headersSent) sendJsonHttp(res, 400, { error: "read failed" });
    }
    return;
  }

  if (size === 0) {
    await fsp.unlink(filePath).catch(() => {});
    sendJsonHttp(res, 400, { error: "empty body" });
    return;
  }

  console.log(`[upload] saved ${filePath} (${size} bytes)`);
  sendJsonHttp(res, 200, { path: filePath, name: filename, size });
  void pruneUploads(); // keep the upload dir bounded
}

/**
 * Create a new, empty upload file named after `suffix`, open for writing.
 *
 * Exclusive ("wx"): the random part of the name is what keeps two uploads in
 * the same second apart, and with the file now written as it streams in, a
 * clash would have two requests writing into one file. On the off chance the
 * name is taken, a fresh one is drawn.
 */
async function createUploadFile(
  suffix: string
): Promise<{ handle: fsp.FileHandle; filePath: string; filename: string }> {
  for (let attempt = 0; ; attempt++) {
    const stamp = new Date()
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\..+$/, "")
      .replace("T", "_");
    const rand = Math.random().toString(36).slice(2, 8) || "x";
    const filename = `clip-${stamp}-${rand}${suffix}`;
    const filePath = path.join(config.uploadDir, filename);
    try {
      return { handle: await fsp.open(filePath, "wx", 0o600), filePath, filename };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 4) throw err;
    }
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
  // Not a valid name: unknown, rather than the cwd of a session it was
  // cleaned up into.
  const name = sessionName(session);
  return name ? tmuxSessionCwd(name) : Promise.resolve(null);
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
  sendFileBody(res, abs, "download");
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

      // DNS rebinding and cross-site requests (see auth.ts). Before the token
      // gate, so the login POST is covered too. Only state-changing requests
      // are origin-checked: a cross-site GET can't read the answer.
      if (!hostAllowed(req, config.allowedHosts)) {
        sendForbidden(res, "Host not allowed. Add it to ALLOWED_HOSTS if it is yours.");
        return;
      }
      if (method !== "GET" && method !== "HEAD" && !originAllowed(req)) {
        sendForbidden(res, "Cross-origin request refused.");
        return;
      }

      // Sign-in gate for Cloudflare-fronted requests: the login page, the login
      // and logout POSTs, the passkey sign-in, the ?token=… sign-in for every
      // route, and the refusal when no token is configured. Direct/tailnet
      // requests pass straight through.
      if (await gateHttp(req, res, requestUrl, config.authToken)) return;

      // /api/auth and /api/passkeys…: the app's Passkeys panel.
      if (await handleAuthApi(req, res, requestUrl, config.authToken)) return;

      if (method === "POST" && requestUrl.pathname === "/upload") {
        await handleUpload(req, res, requestUrl.searchParams.get("name"));
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/health") {
        // Behind the token gate like everything else: through Cloudflare it
        // needs a sign-in, like any other route.
        sendJsonHttp(res, 200, { ok: true, commit: RUNNING_COMMIT, startedAt: STARTED_AT });
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
// How long after the last resize to make tmux repaint. Long enough that
// dragging a window costs one repaint rather than sixty.
//
// The browser's split needs nothing from tmux now — two sessions side by side
// have no border to draw. This is for a split made INSIDE tmux, which is still
// one window drawn into one grid: tmux sends only differences, so a grid that
// drifts from its model keeps a crooked border until something redraws it all.
const REPAINT_DELAY_MS = 400;
const HEARTBEAT_MS = 20_000;
// Output backpressure. ws.send never refuses: on a slow link (a phone through
// the tunnel) a burst like `cat` of a big file queued in this process without
// limit. Past the high mark the pty is paused — tmux then holds the output, as
// it does for any slow client — and resumed once the queue drains below the low.
const WS_HIGH_WATER = 1024 * 1024;
const WS_LOW_WATER = 256 * 1024;
// While paused, how often to look again, beside the check in each send's callback.
const WS_DRAIN_POLL_MS = 100;

/** Parse a ?cols=/?rows= param, falling back when absent or out of bounds. */
function parseDim(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < MIN_DIM || n > max) return fallback;
  return n;
}

// This server's own configuration env vars — every one config.ts reads, taken
// from its list so the two can't drift. They must NOT leak into the user's
// shell: AUTH_TOKEN is a secret anything in the terminal could read, and zsh's
// `%m` prompt escape reads $HOST, so an exported HOST (the bind address) would
// make the prompt show "100" instead of the real hostname.
//
// TMUX and TMUX_PANE too: a server started from inside tmux would otherwise
// hand them on, and a tmux client that sees $TMUX thinks it is nested in that
// server — attaching refuses, and on a test socket it names the wrong server.
const SERVER_ENV_VARS: readonly string[] = [...CONFIG_ENV_VARS, "TMUX", "TMUX_PANE"];

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

/**
 * A client-supplied value made safe to put in a log line: control characters
 * (newlines above all) and the Unicode line separators become `\xNN` / `\uNNNN`
 * escapes, so nothing a client sends can end the line and forge the next one.
 */
function logSafe(value: unknown): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (c) => {
    const code = c.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

// The largest frame a client may send. What comes this way is keystrokes,
// pastes and small JSON — files go over HTTP (/upload) — and ws's default of
// 100 MB let any one client make the server hold that much for a single
// message. A bigger frame closes the socket (1009). Not 1 MB: a paste goes up
// as ONE frame with no size cap of its own on the client (its input path is
// frozen), so a cap that low would quietly lose a large paste along with the
// connection. 16 MB is past any paste a person makes and still bounded.
const WS_MAX_PAYLOAD = 16 * 1024 * 1024;

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

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
  let create = false;
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  try {
    const u = new URL(req.url ?? "/ws", "http://localhost");
    requested = u.searchParams.get("session");
    create = u.searchParams.get("create") === "1";
    cols = parseDim(u.searchParams.get("cols"), DEFAULT_COLS, MAX_COLS);
    rows = parseDim(u.searchParams.get("rows"), DEFAULT_ROWS, MAX_ROWS);
  } catch {
    requested = null;
  }
  // No ?session at all: the default one (validated at startup). Otherwise the
  // name exactly as sent, or nothing. It used to be cleaned up and cut to 64,
  // and a cut name is someone else's: the second half `X__b` of a 64-character
  // tab `X` was cut back to `X` itself, so both halves of the split attached to
  // the first one — and a restart in either killed it.
  const session = requested === null ? config.defaultSession : sessionName(requested);
  if (!session) {
    console.warn(`[ws] refused invalid session name "${logSafe(requested)}"`);
    sendJson(ws, { type: "info", message: "Invalid session name." });
    try {
      ws.close(1008, "invalid session name");
    } catch {
      /* ignore */
    }
    return;
  }

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

  if (create) {
    clearClosed(session);
  } else if (isClosed(session)) {
    // Closed on purpose, and this connect is not asking for it back — a page
    // that slept through the close, reconnecting what it had. Unless the
    // session is somehow there anyway (made from a shell, say), it gets told
    // the tab is closed rather than a fresh empty session under the old name.
    void listTmuxSessions().then((names) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (names?.includes(session)) {
        startAttach(ws, session, cols, rows);
        return;
      }
      console.log(`[ws] refused "${session}": closed, and not asked to create it`);
      sendJson(ws, { type: "closed" });
      try {
        ws.close(1000, "closed");
      } catch {
        /* ignore */
      }
    });
    return;
  }
  startAttach(ws, session, cols, rows);
});

/**
 * Attach, starting a brand-new second half of a split where the first half is
 * working: opening the split is for doing something next to what is on screen,
 * and a shell in the home directory meant a `cd` back there every time.
 */
function startAttach(ws: LiveSocket, session: string, cols: number, rows: number): void {
  if (!session.endsWith(MATE_SUFFIX)) {
    attachSession(ws, session, cols, rows);
    return;
  }
  void mateStartDir(session, session.slice(0, -MATE_SUFFIX.length)).then((dir) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    attachSession(ws, session, cols, rows, dir ?? undefined);
  });
}

/** Spawn the tmux client for `session` and wire it to this socket. */
function attachSession(
  ws: LiveSocket,
  session: string,
  cols: number,
  rows: number,
  startDir?: string
): void {
  let proc: pty.IPty;
  try {
    proc = spawnTmuxPty(tmuxArgs(session, config.tmuxConfPath, startDir), {
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
  //
  // Except the second half of a split: it is reached through the tab it is
  // named after, and a tab of its own is the one thing it must not become.
  //
  // The write is skipped when a list fetched a moment ago already shows it
  // tagged — a deploy reconnects every tab on every device at once. It doesn't
  // drop the cached list either: liveSessions already puts this tab in it.
  if (!session.endsWith(MATE_SUFFIX)) {
    liveSessions.add(session);
    if (!knownTagged(session)) tagWebSession(session);
  }
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
      })();
    }, REPAINT_DELAY_MS);
  };

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

  // Output backpressure (see WS_HIGH_WATER). Only this client's pty is paused:
  // every socket has its own tmux client, so a slow phone holds up no one else.
  let outputPaused = false;
  let drainTimer: NodeJS.Timeout | null = null;
  const stopDrainWatch = (): void => {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
  };
  const checkDrained = (): void => {
    if (!outputPaused) return;
    // A socket that is no longer open never drains; let the pty go rather than
    // leave it paused for good.
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount >= WS_LOW_WATER) return;
    outputPaused = false;
    stopDrainWatch();
    try {
      proc.resume();
    } catch {
      /* the pty is already gone */
    }
  };

  // pty output -> ws (binary)
  const onData = proc.onData((data: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      // node-pty emits strings; send raw bytes so xterm gets exact output.
      ws.send(Buffer.from(data, "utf8"), { binary: true }, checkDrained);
      if (!outputPaused && ws.bufferedAmount > WS_HIGH_WATER) {
        outputPaused = true;
        proc.pause();
        // The send callbacks see most of the drain; the timer catches the rest.
        drainTimer = setInterval(checkDrained, WS_DRAIN_POLL_MS);
      }
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
    stopDrainWatch();
    liveSessions.delete(session);
    livePtys.delete(proc);
    // The session may have ended with it (its last shell exited): the cached
    // tab list, and the tag it says this session has, may be out of date.
    invalidateWebTabs();
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
      } else if (parsed.type === "ping") {
        sendJson(ws, { type: "pong" });
      } else if (parsed.type === "restart") {
        // Kill this session's tmux session. The attached pty (tmux client)
        // then exits, the ws closes, and the client reconnects into a fresh
        // session via `new-session -A`.
        //
        // Same kill, same insurance as closing a tab: restarting one session is
        // not meant to cost the other twelve, which is what it does on the day
        // this command takes the server with it.
        //
        // `session` was checked to be exactly a valid name when this socket
        // connected (see the connection handler), so this kills that session
        // and no other.
        void snapshotBeforeKill(session)
          .then(() => killSession(session))
          .then((err) => {
            if (err) {
              console.error(
                `[ws] restart: kill-session "${session}" failed:`,
                err.message
              );
              sendJson(ws, { type: "info", message: "Restart failed." });
            }
          });
      } else if (parsed.type === "debug") {
        // Every field the client controls goes through logSafe, so a newline
        // in one can't start a forged line of its own in the log.
        console.error(
          `[ime-debug] session=${session} event=${logSafe(parsed.event)} ` +
            `data=${logSafe(JSON.stringify(parsed.data ?? ""))} at=${logSafe(parsed.at ?? "")}`
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
    stopDrainWatch();
    onData.dispose();
    onExit.dispose();
    removeSessionClient(session, ws);
    cleanup();
    console.log(`[ws] disconnected from "${session}" (tmux session persists)`);
  });
}

wss.on("error", (err) => {
  console.error("[wss] server error:", err);
});

/** Answer an upgrade we won't do with a bare HTTP status, and drop the socket. */
function refuseSocket(socket: Duplex, status: string): void {
  try {
    if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* the socket may already be gone */
  }
  socket.destroy();
}

// Upgrade only on the /ws path; reject everything else.
server.on("upgrade", (req, socket, head) => {
  // Nothing in here may throw out of the listener: there is no request
  // handler's catch around an upgrade, so a throw would reach
  // uncaughtException and leave the socket hanging open.
  try {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      refuseSocket(socket, "400 Bad Request");
      return;
    }

    if (pathname !== "/ws") {
      refuseSocket(socket, "404 Not Found");
      return;
    }

    // A WebSocket isn't covered by CORS: without these, any page open in a
    // browser on the tailnet could open one and type into a shell (see
    // auth.ts). The Origin check applies to every upgrade, not only to
    // state-changing HTTP — the socket IS the state change.
    if (!hostAllowed(req, config.allowedHosts) || !originAllowed(req)) {
      refuseSocket(socket, "403 Forbidden");
      return;
    }

    // The terminal stream is the sensitive part: through Cloudflare, refuse the
    // upgrade unless the request carries the auth cookie (the browser sends it
    // automatically once signed in), and always when no token is configured.
    const refusal = refuseUpgrade(req, config.authToken);
    if (refusal) {
      refuseSocket(socket, refusal);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (err) {
    console.error("[ws] upgrade error:", err);
    refuseSocket(socket, "500 Internal Server Error");
  }
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
async function readSnapshot(): Promise<{ panes: number; names: string[]; savedAt: number } | null> {
  const file = path.join(RESURRECT_DIR, "last");
  try {
    const [text, stat] = await Promise.all([
      fsp.readFile(file, "utf8"),
      fsp.stat(file),
    ]);
    const lines = text.split("\n").filter((line) => line.startsWith("pane\t"));
    const names = new Set(lines.map((line) => line.split("\t")[1]));
    return { panes: lines.length, names: [...names], savedAt: stat.mtimeMs };
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
//
// Sessions this server killed on purpose are taken off the count it compares
// against (see snapshotCollapsed in tmux.ts). Closing a split tab is two of its
// sessions at once — out of four, half — and the snapshot taken just before
// the kill still held both, so every save after it was skipped for two hours.
const COLLAPSE_GRACE_MS = 2 * 60 * 60_000;

/** Session name -> when this server killed it on purpose (epoch ms). */
const deliberateKills = new Map<string, number>();

function noteDeliberateKill(name: string): void {
  const now = Date.now();
  deliberateKills.set(name, now);
  // Past the grace period the guard no longer looks at the snapshot it would
  // matter to, so older entries can go.
  for (const [n, at] of deliberateKills) {
    if (now - at > COLLAPSE_GRACE_MS + SNAPSHOT_TIMEOUT_MS) deliberateKills.delete(n);
  }
}

/**
 * How long to wait for a save before going ahead without it. The snapshot is
 * insurance, not a gate: whatever the user asked for still has to happen.
 */
const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * Off on a test socket (TERMINAL_WEB_TMUX_SOCKET): resurrect's scripts run
 * plain `tmux`, which is the user's own server, not the scratch one. A test
 * that snapshotted would be reading the real server — and, run with the real
 * HOME, writing over the real `last`. Periodic, startup and before-kill alike.
 */
const SNAPSHOTS_ENABLED = !config.tmuxSocket;

/**
 * One save at a time (see SingleFlight in tmux.ts). Closing several tabs in a
 * row, or pressing restart a few times, used to run as many save.sh at once,
 * all writing snapshots named for the same second.
 */
const snapshots = new SingleFlight(
  (reasons) => saveSnapshot(reasons.join("; ")),
  (err) => console.error("[snapshot] save threw:", err)
);

/** Take a snapshot that starts after this call; resolves when it is done. Never rejects. */
function snapshotSessions(reason = "interval"): Promise<void> {
  if (!SNAPSHOTS_ENABLED) return Promise.resolve(); // periodic, startup and before-kill alike
  return snapshots.run(reason);
}

async function saveSnapshot(reason: string): Promise<void> {
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
  const guard = snapshotCollapsed({
    live: names.length,
    snapshot: previous,
    killedAt: deliberateKills,
    saveWindowMs: SNAPSHOT_TIMEOUT_MS,
    graceMs: COLLAPSE_GRACE_MS,
    now: Date.now(),
  });
  if (guard.collapsed) {
    console.error(
      `[snapshot] NOT saving: ${names.length} session(s) live but the last ` +
        `snapshot holds ${guard.baseline} not closed on purpose — keeping it ` +
        "rather than writing over the only record of what was there. Restore " +
        `from ${RESURRECT_DIR} if this was not deliberate.`
    );
    return;
  }
  // buildChildEnv for the locale: resurrect's format is tab-separated and tmux
  // only emits real tabs under a UTF-8 locale (see readSnapshot).
  //
  // Awaited, rather than left to finish on its own, because a caller about to
  // kill a session needs the save to have happened BEFORE it does — see
  // snapshotBeforeKill.
  const saved = await new Promise<boolean>((resolve) => {
    execFile(
      RESURRECT_SAVE,
      ["quiet"],
      { env: buildChildEnv(), timeout: SNAPSHOT_TIMEOUT_MS },
      (err) => {
        if (err) {
          console.error(`[snapshot] resurrect save failed (${reason}):`, err.message);
          resolve(false);
          return;
        }
        resolve(true);
      }
    );
  });
  if (!saved) return;
  const snap = await readSnapshot();
  const panes = snap?.panes ?? null;
  if (panes === null) {
    console.error("[snapshot] saved, but the snapshot could not be read back");
  } else if (panes === 0) {
    console.error(
      `[snapshot] SAVED NOTHING: ${names.length} session(s) live but the ` +
        "snapshot holds no panes — it cannot be restored from"
    );
  } else {
    console.log(
      `[snapshot] saved ${panes} pane(s) across ${names.length} session(s) (${reason})`
    );
  }
}

/**
 * Save before killing anything, and wait for it.
 *
 * `tmux kill-session` is the one command here that has been observed to take a
 * whole tmux server with it: on the NUC (tmux 3.4) every server death in a
 * fortnight — four of them — landed within a second of one, each time with the
 * kill itself reporting "server exited unexpectedly", and each time every other
 * session went with it. Reproducing it on a scratch server never worked, so
 * what is treated here is the damage rather than the cause: a snapshot taken
 * in the moment before means a death costs seconds instead of the up-to-five
 * minutes back to the last interval save, whatever it turns out to be.
 *
 * Never fatal, and bounded: the kill the user asked for happens either way.
 * A save already running is let finish and then a new one is taken — one that
 * began before this was asked for may have listed the sessions too early — so
 * the wait is at most two saves, and PRE_KILL_WAIT_MS caps it outright.
 */
async function snapshotBeforeKill(name: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PRE_KILL_WAIT_MS);
  });
  try {
    const outcome = await Promise.race([snapshotSessions(`before killing "${name}"`), timedOut]);
    if (outcome === "timeout") {
      console.error(
        `[snapshot] no snapshot after ${PRE_KILL_WAIT_MS} ms; killing "${name}" without waiting longer`
      );
    }
  } catch (err) {
    console.error("[snapshot] pre-kill save threw:", err);
  } finally {
    clearTimeout(timer);
  }
}

/** The longest a kill waits for its snapshot: two saves, with room for listing. */
const PRE_KILL_WAIT_MS = 2 * SNAPSHOT_TIMEOUT_MS + 5_000;

if (SNAPSHOTS_ENABLED) {
  setTimeout(() => void snapshotSessions(), FIRST_SNAPSHOT_MS).unref();
  const snapshotTimer = setInterval(() => void snapshotSessions(), SNAPSHOT_MS);
  snapshotTimer.unref();
}

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
  } else if (!config.tailscaleProbed) {
    console.log("  Tailscale: (not asked — HOST is set)");
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
  if (config.tmuxSocket) {
    console.log(
      `  tmux socket: -L ${config.tmuxSocket}  (TERMINAL_WEB_TMUX_SOCKET; snapshots off)`
    );
  } else {
    console.log("  tmux socket: default");
  }
  if (config.allowedHosts.length) {
    console.log(`  Extra allowed hosts: ${config.allowedHosts.join(", ")}`);
  }
  if (!config.authToken) {
    console.warn(
      "  WARNING: AUTH_TOKEN is empty. Requests through Cloudflare will be refused (403); " +
        "direct/tailnet access stays open."
    );
  }
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
