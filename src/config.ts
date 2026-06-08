import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  return {
    port,
    host,
    hostFromTailscale,
    defaultSession,
    repoRoot: REPO_ROOT,
    tmuxConfPath: path.join(REPO_ROOT, "tmux", "web.tmux.conf"),
    publicDir: path.join(REPO_ROOT, "public"),
    tailscaleIp,
  };
}
