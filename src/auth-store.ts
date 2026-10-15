/**
 * What sign-in remembers on disk: the sessions the server has issued and the
 * passkeys registered with it. Both are loaded once, at startup
 * (initAuthStore), and kept in memory; a request never reads the files.
 *
 *   ~/.terminal-web/auth-sessions.json   SHA-256 of each session id, never the
 *                                        id itself, with how it was made
 *   ~/.terminal-web/passkeys.json        the passkeys (public keys only), and
 *                                        the one user handle they share
 *
 * Both are written 0600 inside a 0700 directory, through a temp file and a
 * rename, so a crash can't leave a half-written file behind.
 *
 * A session made with the token remembers a fingerprint of the token in force,
 * and dies when AUTH_TOKEN changes. A session made with a passkey remembers
 * the credential id, and dies when that passkey is deleted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Same lifetime as the cookie's Max-Age. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Past this many live sessions, the oldest are dropped. */
const MAX_SESSIONS = 1000;
/** Past this many passkeys, registering another is refused. */
export const MAX_PASSKEYS = 100;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function dataDir(): string {
  return path.join(os.homedir(), ".terminal-web");
}
function sessionsFile(): string {
  return path.join(dataDir(), "auth-sessions.json");
}
function passkeysFile(): string {
  return path.join(dataDir(), "passkeys.json");
}

// ---------------------------------------------------------------------------
// Private files
// ---------------------------------------------------------------------------

/** One chain per file, so two quick writes land in order. */
const writeChains = new Map<string, Promise<void>>();
let tmpSeq = 0;

/**
 * Write `value` as JSON to `file`, 0600, via a temp file and a rename. The
 * text is taken now, so a later change can't leak into an earlier write.
 */
function writePrivateJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    const dir = path.dirname(file);
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      // The directory may predate this (closed.json, prefs.json): tighten it.
      await fsp.chmod(dir, 0o700).catch(() => undefined);
      await fsp.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
      await fsp.chmod(tmp, 0o600);
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      console.error(`[auth] write of ${path.basename(file)} failed:`, (err as Error).message);
    }
  });
  writeChains.set(file, next);
  return next;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auth] ${path.basename(file)} unreadable, starting empty:`, (err as Error).message);
    }
    return undefined;
  }
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** A random 32-byte value, base64url (43 characters). */
export function randomId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

export interface StoredPasskey {
  /** Credential id, base64url. */
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  /** The hostname it was registered on; it only signs in there. */
  rpId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface PasskeyFile {
  /** The one WebAuthn user handle every passkey here is made for, base64url. */
  userId: string;
  passkeys: StoredPasskey[];
}

let passkeyData: PasskeyFile = { userId: randomId(), passkeys: [] };

function validPasskey(p: unknown): p is StoredPasskey {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    B64URL_RE.test(o.id) &&
    typeof o.publicKey === "string" &&
    B64URL_RE.test(o.publicKey) &&
    typeof o.counter === "number" &&
    Number.isFinite(o.counter) &&
    Array.isArray(o.transports) &&
    o.transports.every((t) => typeof t === "string") &&
    typeof o.rpId === "string" &&
    typeof o.name === "string" &&
    typeof o.createdAt === "number" &&
    (o.lastUsedAt === null || typeof o.lastUsedAt === "number")
  );
}

function loadPasskeys(): PasskeyFile {
  const raw = readJsonFile(passkeysFile());
  // A bare array is accepted too, in case someone writes one by hand.
  const obj: { userId?: unknown; passkeys?: unknown } | undefined = Array.isArray(raw)
    ? { passkeys: raw }
    : raw && typeof raw === "object"
      ? (raw as { userId?: unknown; passkeys?: unknown })
      : undefined;
  const userId =
    obj && typeof obj.userId === "string" && B64URL_RE.test(obj.userId) ? obj.userId : randomId();
  const list = obj && Array.isArray(obj.passkeys) ? obj.passkeys : [];
  return { userId, passkeys: list.filter(validPasskey) };
}

function savePasskeys(): Promise<void> {
  return writePrivateJson(passkeysFile(), passkeyData);
}

export function passkeyUserId(): string {
  return passkeyData.userId;
}

export function listPasskeys(): readonly StoredPasskey[] {
  return passkeyData.passkeys;
}

export function findPasskey(id: string): StoredPasskey | undefined {
  return passkeyData.passkeys.find((p) => p.id === id);
}

export function addPasskey(p: StoredPasskey): void {
  passkeyData.passkeys.push(p);
  void savePasskeys();
}

/** Record a successful sign-in with `id`. */
export function touchPasskey(id: string, counter: number): void {
  const p = findPasskey(id);
  if (!p) return;
  p.counter = counter;
  p.lastUsedAt = Date.now();
  void savePasskeys();
}

/** Remove a passkey and every session it signed in. False when there was none. */
export function removePasskey(id: string): boolean {
  const before = passkeyData.passkeys.length;
  passkeyData.passkeys = passkeyData.passkeys.filter((p) => p.id !== id);
  if (passkeyData.passkeys.length === before) return false;
  void savePasskeys();
  let killed = false;
  for (const [hash, rec] of sessions) {
    if (rec.method === "passkey" && rec.credentialId === id) {
      sessions.delete(hash);
      killed = true;
    }
  }
  if (killed) saveSessions();
  return true;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface SessionBase {
  createdAt: number;
  expiresAt: number;
}
export type SessionRecord =
  | (SessionBase & { method: "token"; tokenFp: string })
  | (SessionBase & { method: "passkey"; credentialId: string });

/** sha256(session id) -> record, oldest first. */
let sessions = new Map<string, SessionRecord>();
/** Fingerprint of the AUTH_TOKEN in force; empty when none is set. */
let currentTokenFp = "";

/**
 * A fingerprint of the token, kept so a token session can be tied to the token
 * that made it. Domain-separated SHA-256: the token itself is never stored.
 */
function tokenFingerprint(token: string): string {
  return token ? sha256Hex(`terminal-web token fingerprint\0${token}`) : "";
}

function validRecord(rec: unknown): rec is SessionRecord {
  if (!rec || typeof rec !== "object") return false;
  const o = rec as Record<string, unknown>;
  if (typeof o.createdAt !== "number" || typeof o.expiresAt !== "number") return false;
  if (o.method === "token") return typeof o.tokenFp === "string";
  if (o.method === "passkey") return typeof o.credentialId === "string";
  return false;
}

/** Whether a record still stands: not expired, its token or passkey still current. */
function recordLive(rec: SessionRecord, now: number): boolean {
  if (rec.expiresAt <= now) return false;
  if (rec.method === "token") return currentTokenFp !== "" && rec.tokenFp === currentTokenFp;
  return findPasskey(rec.credentialId) !== undefined;
}

/** Drop dead records and cap the store. True when anything went. */
function pruneSessions(): boolean {
  const now = Date.now();
  let changed = false;
  for (const [hash, rec] of sessions) {
    if (!recordLive(rec, now)) {
      sessions.delete(hash);
      changed = true;
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    sessions = new Map(sorted.slice(sorted.length - MAX_SESSIONS));
    changed = true;
  }
  return changed;
}

function loadSessions(): Map<string, SessionRecord> {
  const raw = readJsonFile(sessionsFile()) as { sessions?: unknown } | undefined;
  const out = new Map<string, SessionRecord>();
  const obj = raw && typeof raw === "object" ? raw.sessions : undefined;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter((e): e is [string, SessionRecord] => /^[0-9a-f]{64}$/.test(e[0]) && validRecord(e[1]))
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [hash, rec] of entries) out.set(hash, rec);
  }
  return out;
}

function saveSessions(): void {
  pruneSessions();
  void writePrivateJson(sessionsFile(), { version: 1, sessions: Object.fromEntries(sessions) });
}

/** Issue a new session; returns its id (the cookie value). */
export function issueSession(
  how: { method: "token" } | { method: "passkey"; credentialId: string },
): string {
  const id = randomId();
  const now = Date.now();
  const base = { createdAt: now, expiresAt: now + SESSION_TTL_MS };
  const rec: SessionRecord =
    how.method === "token"
      ? { ...base, method: "token", tokenFp: currentTokenFp }
      : { ...base, method: "passkey", credentialId: how.credentialId };
  sessions.set(sha256Hex(id), rec);
  saveSessions();
  return id;
}

/** The live session a cookie value names, or null. */
export function lookupSession(id: string): SessionRecord | null {
  if (!SESSION_ID_RE.test(id)) return null;
  const hash = sha256Hex(id);
  const rec = sessions.get(hash);
  if (!rec) return null;
  if (recordLive(rec, Date.now())) return rec;
  sessions.delete(hash); // written out with the next change
  return null;
}

/** Forget one session (sign-out). */
export function revokeSession(id: string): void {
  if (!SESSION_ID_RE.test(id)) return;
  if (sessions.delete(sha256Hex(id))) saveSessions();
}

/**
 * Load both stores. Called once, before the server listens. A store that lost
 * entries to pruning (expired, or made with a token that is no longer the
 * one in force) is written back at once.
 */
export function initAuthStore(token: string): void {
  currentTokenFp = tokenFingerprint(token);
  passkeyData = loadPasskeys();
  sessions = loadSessions();
  const loaded = sessions.size;
  if (pruneSessions()) saveSessions();
  console.log(
    `[auth] ${sessions.size} sign-in session(s) (${loaded - sessions.size} dropped), ` +
      `${passkeyData.passkeys.length} passkey(s)`,
  );
}
