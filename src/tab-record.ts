/**
 * The tab record: which tmux sessions are web tabs, kept outside tmux.
 *
 * tmux is the source of truth for the tab list (the @twtab option, label in
 * @twlabel — see tmux.ts), but tmux-resurrect restores sessions without user
 * options. Before this, a restored session became a tab again only if some
 * device still had it cached and asked for it back (/api/sessions/adopt); the
 * rest kept running, invisible and unkillable from the page. The record is
 * what lets the server tag them again itself (see cachedWebTabs in server.ts).
 *
 *   ~/.terminal-web/tabs.json
 *   { "version": 1, "tabs": { "<name>": { "label": "...", "lastSeen": <ms> } } }
 *
 * - A name goes in (or has its label updated) whenever the server tags a
 *   session. Second halves (`__b`) never do: their tab carries them.
 * - A name comes out only when the server kills it as a closed tab, or when it
 *   has not been seen alive in tmux for RECORD_TTL_MS. A tmux server that dies
 *   removes nothing — the list it gives is "unknown", not "empty".
 *
 * Loaded once (initTabRecord); written like closed.json, 0600, through a temp
 * file and a rename, debounced. A corrupt or missing file reads as empty, and
 * nothing in here ever throws to the caller.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sessionName } from "./tmux.js";

const MATE_SUFFIX = "__b";
/** A name not seen alive in tmux for this long is dropped. */
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * lastSeen is bumped in memory on every list, but only written when it has
 * moved this much: the only thing it decides is a 30-day cut-off, and a list
 * is fetched up to once a second.
 */
const LAST_SEEN_WRITE_MS = 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 250;

interface Entry {
  label: string;
  lastSeen: number;
}

function recordFile(): string {
  return path.join(os.homedir(), ".terminal-web", "tabs.json");
}

/** name -> entry. */
let tabs = new Map<string, Entry>();
/** lastSeen of each name as last written, to tell whether a bump is worth a write. */
const writtenLastSeen = new Map<string, number>();
let dirty = false;
let writeTimer: NodeJS.Timeout | null = null;
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;
/** Writes started and not yet finished. */
let inFlight = 0;

/** Whether a name can be in the record at all. */
function recordable(name: string): boolean {
  return sessionName(name) !== null && !name.endsWith(MATE_SUFFIX);
}

/** Same clean-up setWebTabLabel applies, so the record holds what tmux holds. */
function cleanLabel(name: string, label: string | undefined): string {
  if (typeof label !== "string") return name;
  return label.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 64) || name;
}

function parse(raw: unknown): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as { version?: unknown; tabs?: unknown };
  if (obj.version !== 1) return out;
  if (!obj.tabs || typeof obj.tabs !== "object" || Array.isArray(obj.tabs)) return out;
  for (const [name, value] of Object.entries(obj.tabs as Record<string, unknown>)) {
    if (!recordable(name) || !value || typeof value !== "object") continue;
    const e = value as { label?: unknown; lastSeen?: unknown };
    if (typeof e.lastSeen !== "number" || !Number.isFinite(e.lastSeen)) continue;
    out.set(name, {
      label: cleanLabel(name, typeof e.label === "string" ? e.label : undefined),
      lastSeen: e.lastSeen,
    });
  }
  return out;
}

function serialize(): string {
  const obj: Record<string, Entry> = {};
  for (const [name, e] of tabs) obj[name] = { label: e.label, lastSeen: e.lastSeen };
  return JSON.stringify({ version: 1, tabs: obj }, null, 2);
}

function markWritten(): void {
  writtenLastSeen.clear();
  for (const [name, e] of tabs) writtenLastSeen.set(name, e.lastSeen);
  dirty = false;
}

function scheduleWrite(): void {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!dirty) return;
    const text = serialize();
    markWritten();
    const file = recordFile();
    // Chained, so two quick writes cannot land out of order.
    inFlight++;
    writeChain = writeChain.then(async () => {
      const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fsp.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
        await fsp.chmod(tmp, 0o600);
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => undefined);
        console.error("[tabs] write of tabs.json failed:", (err as Error).message);
      } finally {
        inFlight--;
      }
    });
  }, WRITE_DEBOUNCE_MS);
}

/**
 * A write still waiting on its debounce (or still on its way to disk) when the
 * process exits goes out now, synchronously.
 */
function flushSync(): void {
  if (!dirty && inFlight === 0) return;
  const file = recordFile();
  const tmp = `${file}.${process.pid}.exit.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, serialize(), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    dirty = false;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Read the record from disk. Call once, at startup. Never throws. */
export function initTabRecord(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(recordFile(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[tabs] tabs.json unreadable, starting empty:", (err as Error).message);
    }
    raw = undefined;
  }
  tabs = parse(raw);
  markWritten();
  process.once("exit", flushSync);
}

/**
 * The server just tagged `name` as a tab: put it in the record. `label` is the
 * display name when the caller knows it (a rename, a re-tag); without one an
 * entry already there keeps its label and a new one is labelled with its name.
 */
export function recordTab(name: string, label?: string): void {
  if (!recordable(name)) return;
  const prev = tabs.get(name);
  const next: Entry = {
    label: label === undefined ? (prev?.label ?? name) : cleanLabel(name, label),
    lastSeen: Date.now(),
  };
  tabs.set(name, next);
  const seen = writtenLastSeen.get(name);
  if (
    !prev ||
    prev.label !== next.label ||
    seen === undefined ||
    next.lastSeen - seen >= LAST_SEEN_WRITE_MS
  ) {
    scheduleWrite();
  }
}

/** The tabs were closed on purpose: they are not tabs any more. */
export function forgetTabs(names: readonly string[]): void {
  let changed = false;
  for (const n of names) changed = tabs.delete(n) || changed;
  if (changed) scheduleWrite();
}

export function isRecorded(name: string): boolean {
  return tabs.has(name);
}

/** The recorded label, or undefined when the name is not in the record. */
export function recordedLabel(name: string): string | undefined {
  return tabs.get(name)?.label;
}

/**
 * Every session tmux has right now (a list that really came back — never call
 * this for an unknown one). Names alive get their lastSeen bumped; names not
 * seen for RECORD_TTL_MS are dropped.
 */
export function observeSessions(alive: readonly string[]): void {
  const now = Date.now();
  const live = new Set(alive);
  let write = false;
  for (const [name, e] of tabs) {
    if (live.has(name)) {
      e.lastSeen = now;
      const seen = writtenLastSeen.get(name);
      if (seen === undefined || now - seen >= LAST_SEEN_WRITE_MS) write = true;
    } else if (now - e.lastSeen > RECORD_TTL_MS) {
      tabs.delete(name);
      console.log(`[tabs] dropped from the tab record (not seen for 30 days): ${name}`);
      write = true;
    }
  }
  if (write) scheduleWrite();
}
