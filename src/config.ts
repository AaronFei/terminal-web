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
  /** Shared token Cloudflare-fronted requests must present (HTTP + WS). Empty
   *  = those requests are refused outright; direct/tailnet access is open
   *  either way. */
  authToken: string;
  /** Max concurrent ptys/terminals; new connections past this are refused to
   *  protect the host's small system-wide pty table (kern.tty.ptmx_max). */
  maxPtys: number;
  /** Detected Tailscale IPv4 address, if any (for nicer startup logging). */
  tailscaleIp: string | null;
  /** Whether `tailscale ip -4` was asked at all: not when HOST is set. */
  tailscaleProbed: boolean;
  /** tmux socket name (`tmux -L <name>`) every tmux call goes to. Empty = the
   *  default socket, i.e. the user's own tmux server. Meant for tests, so a
   *  scratch server can never touch the real one; it also turns snapshots off. */
  tmuxSocket: string;
  /** Extra dotted hostnames the Host check accepts on direct (non-Cloudflare)
   *  requests, lower-cased. See hostAllowed in auth.ts. */
  allowedHosts: string[];
}

/**
 * Every environment variable this file reads. The server strips all of them
 * from the environment it hands the terminal's shell (see buildChildEnv in
 * server.ts): they are the server's configuration, and AUTH_TOKEN among them is
 * a secret. loadConfig reads env only through `read`, which takes one of these
 * names, so a new variable can't be added without landing on this list too.
 */
export const CONFIG_ENV_VARS = [
  "PORT",
  "HOST",
  "DEFAULT_SESSION",
  "UPLOAD_DIR",
  "UPLOAD_RETENTION_HOURS",
  "UPLOAD_MAX_FILES",
  "UPLOAD_MAX_MB",
  "AUTH_TOKEN",
  "MAX_PTYS",
  "TERMINAL_WEB_TMUX_SOCKET",
  "ALLOWED_HOSTS",
] as const;

type ConfigEnvVar = (typeof CONFIG_ENV_VARS)[number];

/** A tmux session name (see sessionName in tmux.ts); a socket name too. */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// This file lives at <repoRoot>/src/config.ts, so the repo root is one up.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(thisDir, "..");

/**
 * How long `tailscale ip -4` gets before startup goes on without it. It talks to
 * tailscaled, and at boot — or with tailscaled wedged — that can block for as
 * long as the daemon likes. It runs before the server listens, so with no
 * limit a stuck daemon kept the server from starting at all. Past the limit it
 * counts as not detected, the same as tailscale being absent.
 */
const TAILSCALE_PROBE_TIMEOUT_MS = 3000;

/**
 * Detect the first Tailscale IPv4 address via `tailscale ip -4`.
 * Returns null if tailscale is missing, too slow, or returns nothing usable.
 */
function detectTailscaleIp(): string | null {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_PROBE_TIMEOUT_MS,
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
 * Parse ALLOWED_HOSTS: comma-separated hostnames, no ports. A malformed entry
 * stops the server rather than being dropped, so a typo can't leave a name
 * locked out while looking as if it were allowed.
 */
function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const hosts: string[] = [];
  for (const part of raw.split(",")) {
    const h = part.trim().toLowerCase().replace(/\.$/, "");
    if (!h) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) {
      throw new Error(
        `Invalid ALLOWED_HOSTS entry "${part.trim()}": must be a bare hostname (no port, no scheme).`
      );
    }
    hosts.push(h);
  }
  return hosts;
}

/**
 * Load and validate configuration from the environment, applying defaults.
 * Pure aside from reading process.env and (optionally) probing Tailscale.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const read = (key: ConfigEnvVar): string | undefined => env[key];

  const port = parsePort(read("PORT"), 8090);

  // Only asked when it decides something: with HOST set, the answer would just
  // be printed, and asking can hang startup (see TAILSCALE_PROBE_TIMEOUT_MS).
  const hostRaw = read("HOST");
  const hostGiven = !!hostRaw && hostRaw.trim() !== "";
  const tailscaleIp = hostGiven ? null : detectTailscaleIp();

  let host: string;
  let hostFromTailscale = false;
  if (hostGiven && hostRaw) {
    host = hostRaw.trim();
  } else if (tailscaleIp) {
    host = tailscaleIp;
    hostFromTailscale = true;
  } else {
    host = "0.0.0.0";
  }

  // Checked here rather than quietly cleaned up later: a session name is only
  // ever used exactly as given (see sessionName in tmux.ts).
  const defaultSession = (read("DEFAULT_SESSION") ?? "").trim() || "web";
  if (!NAME_RE.test(defaultSession)) {
    throw new Error(
      `Invalid DEFAULT_SESSION "${defaultSession}": must match [A-Za-z0-9_-]{1,64}.`
    );
  }

  const uploadDirRaw = (read("UPLOAD_DIR") ?? "").trim();
  const uploadDir = uploadDirRaw
    ? path.resolve(uploadDirRaw)
    : path.join(os.homedir(), "terminal-web-uploads");

  // Refuse to start on a bad socket name rather than fall back to the default
  // socket: the only reason to set this is to stay off the user's real tmux
  // server, and a fallback would land a test right on it.
  const tmuxSocket = (read("TERMINAL_WEB_TMUX_SOCKET") ?? "").trim();
  if (tmuxSocket && !NAME_RE.test(tmuxSocket)) {
    throw new Error(
      `Invalid TERMINAL_WEB_TMUX_SOCKET "${tmuxSocket}": must match [A-Za-z0-9_-]{1,64}.`
    );
  }

  return {
    port,
    host,
    hostFromTailscale,
    defaultSession,
    repoRoot: REPO_ROOT,
    tmuxConfPath: path.join(REPO_ROOT, "tmux", "web.tmux.conf"),
    publicDir: path.join(REPO_ROOT, "public"),
    uploadDir,
    uploadRetentionHours: parseNonNegInt(read("UPLOAD_RETENTION_HOURS"), 72),
    uploadMaxFiles: parseNonNegInt(read("UPLOAD_MAX_FILES"), 100),
    uploadMaxBytes: parseNonNegInt(read("UPLOAD_MAX_MB"), 1024) * 1024 * 1024,
    authToken: (read("AUTH_TOKEN") ?? "").trim(),
    maxPtys: Math.max(1, parseNonNegInt(read("MAX_PTYS"), 48)),
    tailscaleIp,
    tailscaleProbed: !hostGiven,
    tmuxSocket,
    allowedHosts: parseAllowedHosts(read("ALLOWED_HOSTS")),
  };
}
