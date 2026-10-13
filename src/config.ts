import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

/**
 * Resolved, validated runtime configuration for the terminal-web server.
 */
export interface Config {
  /** TCP port to listen on. */
  port: number;
  /** Host/IP to bind to (Tailscale IPv4 when detectable, else "0.0.0.0"). */
  host: string;
  /** Whether `host` was auto-detected from Tailscale. */
  hostFromTailscale: boolean;
  /** Default tmux session name when none is given in the WS query. */
  defaultSession: string;
  /**
   * Fixed tmux session whose windows are the browser tabs in window mode.
   * Default `main`. View attachment never creates this session; an explicit
   * restart request may recreate it. The name confers no protection.
   */
  mainSession: string;
  /**
   * tmux `-L` socket name. Empty = the default socket (production). Tests set
   * a scratch name; every tmux invocation must use it.
   */
  tmuxSocketName: string;
  /**
   * Optional window-tab mode. Tabs are windows of `mainSession`, attached
   * with ordinary shared current-window semantics. Default off.
   */
  windowMode: boolean;
  /** Prefs / closed-tab state. Tests point this at a temp directory. */
  stateDir: string;
  /** Absolute path to the project root. */
  repoRoot: string;
  /** Absolute path to tmux/web.tmux.conf. */
  tmuxConfPath: string;
  /** Absolute path to the public/ directory (static root). */
  publicDir: string;
  /** Directory where pasted/dropped/attached files are saved (POST /upload). */
  uploadDir: string;
  /** Delete uploaded files older than this many hours (0 = never by age). */
  uploadRetentionHours: number;
  /** Keep at most this many uploaded files (0 = unlimited). */
  uploadMaxFiles: number;
  /** Reject uploads larger than this many bytes. */
  uploadMaxBytes: number;
  /** Shared token required to access the app (HTTP + WS). Empty = no auth. */
  authToken: string;
  /** Max concurrent ptys/terminals; new connections past this are refused to
   *  protect the host's small system-wide pty table (kern.tty.ptmx_max). */
  maxPtys: number;
  /** Detected Tailscale IPv4 address, if any (for nicer startup logging). */
  tailscaleIp: string | null;
}

// This file lives at <repoRoot>/src/config.ts, so the repo root is one up.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(thisDir, "..");

/**
 * Detect the first Tailscale IPv4 address via `tailscale ip -4`.
 * Returns null if tailscale is missing or returns nothing usable.
 */
function detectTailscaleIp(): string | null {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (first && /^\d{1,3}(\.\d{1,3}){3}$/.test(first)) {
      return first;
    }
    return null;
  } catch {
    return null;
  }
}

function parseSocketName(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "";
  const name = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid TMUX_SOCKET_NAME "${raw}": must match [A-Za-z0-9_-]{1,64}. ` +
        "Refusing to fall back to the default socket."
    );
  }
  return name;
}

function parseMainSession(raw: string | undefined): string {
  const source = raw && raw.trim() !== "" ? raw.trim() : "main";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(source)) {
    throw new Error(
      `Invalid MAIN_SESSION "${source}": must match [A-Za-z0-9_-]{1,64}. ` +
        "Refusing to rewrite it into a different session name."
    );
  }
  return source;
}

function parseWindowMode(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  throw new Error(`Invalid WINDOW_MODE "${raw}": use 1 or 0.`);
}

function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT "${raw}": must be an integer in 1..65535.`);
  }
  return n;
}

/**
 * Load and validate configuration from the environment, applying defaults.
 * Pure aside from reading process.env and (optionally) probing Tailscale.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort(env.PORT, 8090);

  const tailscaleIp = detectTailscaleIp();

  let host: string;
  let hostFromTailscale = false;
  if (env.HOST && env.HOST.trim() !== "") {
    host = env.HOST.trim();
  } else if (tailscaleIp) {
    host = tailscaleIp;
    hostFromTailscale = true;
  } else {
    host = "0.0.0.0";
  }

  const defaultSession =
    env.DEFAULT_SESSION && env.DEFAULT_SESSION.trim() !== ""
      ? env.DEFAULT_SESSION.trim()
      : "web";

  const stateDir =
    env.TERMINAL_WEB_STATE_DIR && env.TERMINAL_WEB_STATE_DIR.trim() !== ""
      ? path.resolve(env.TERMINAL_WEB_STATE_DIR.trim())
      : path.join(os.homedir(), ".terminal-web");

  const uploadDir =
    env.UPLOAD_DIR && env.UPLOAD_DIR.trim() !== ""
      ? path.resolve(env.UPLOAD_DIR.trim())
      : path.join(os.homedir(), "terminal-web-uploads");

  return {
    port,
    host,
    hostFromTailscale,
    defaultSession,
    mainSession: parseMainSession(env.MAIN_SESSION),
    tmuxSocketName: parseSocketName(env.TMUX_SOCKET_NAME),
    windowMode: parseWindowMode(env.WINDOW_MODE),
    stateDir,
    repoRoot: REPO_ROOT,
    tmuxConfPath: path.join(REPO_ROOT, "tmux", "web.tmux.conf"),
    publicDir: path.join(REPO_ROOT, "public"),
    uploadDir,
    uploadRetentionHours: parseNonNegInt(env.UPLOAD_RETENTION_HOURS, 72),
    uploadMaxFiles: parseNonNegInt(env.UPLOAD_MAX_FILES, 100),
    uploadMaxBytes: parseNonNegInt(env.UPLOAD_MAX_MB, 1024) * 1024 * 1024,
    authToken: (env.AUTH_TOKEN ?? "").trim(),
    maxPtys: Math.max(1, parseNonNegInt(env.MAX_PTYS, 48)),
    tailscaleIp,
  };
}
