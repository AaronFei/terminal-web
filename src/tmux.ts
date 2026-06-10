import { execFile, execFileSync } from "node:child_process";

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
 * List the names of all currently-running tmux sessions.
 *
 * Returns the session names on success, or `null` when the list can't be
 * determined — `tmux list-sessions` exits non-zero both when tmux is missing
 * and when no server is running (zero sessions), and we can't tell those apart.
 * Callers treat `null` as "unknown" and keep their existing state rather than
 * wrongly concluding every session is gone. Never throws.
 */
export function listTmuxSessions(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const names = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve(names);
      }
    );
  });
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
