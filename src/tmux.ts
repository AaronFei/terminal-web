import { execFileSync } from "node:child_process";

/**
 * Sanitize a requested tmux session name.
 *
 * Per the protocol: keep only [A-Za-z0-9_-], length 1..64. Anything that does
 * not yield a valid name falls back to "web".
 */
export function sanitizeSession(name: string | null | undefined): string {
  if (typeof name !== "string") return "web";
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length === 0) return "web";
  return cleaned.slice(0, 64);
}

/**
 * Build the argv passed to the `tmux` binary (node-pty spawns "tmux" + these).
 *
 * Uses `new-session -A` so it attaches to an existing session of the same name
 * or creates it if missing — the core of the resume behavior. The session is
 * assumed to already be sanitized by the caller.
 *
 * `-u` forces tmux to treat the client as UTF-8 capable regardless of the
 * locale it detects, so CJK/wide characters render correctly instead of being
 * replaced with "_" placeholders.
 */
export function tmuxArgs(session: string, confPath: string): string[] {
  return ["-u", "-f", confPath, "new-session", "-A", "-s", session];
}

/**
 * Check whether the `tmux` binary is available on PATH.
 *
 * Returns true if `tmux -V` succeeds, false otherwise. Never throws.
 */
export function ensureTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Like {@link ensureTmuxAvailable} but throws a clear, actionable error when
 * tmux is missing — useful for fail-fast startup.
 */
export function requireTmux(): void {
  if (!ensureTmuxAvailable()) {
    throw new Error(
      "tmux was not found on PATH. Install it (e.g. `brew install tmux` on macOS) and try again."
    );
  }
}
