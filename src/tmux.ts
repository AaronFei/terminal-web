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

// ---------------------------------------------------------------------------
// Web-tab membership lives on the tmux session itself, via user options:
//   @twtab   = "1"     -> this session is a web tab (shown on every device)
//   @twlabel = "..."   -> the tab's display label
//
// Making tmux the single source of truth means the tab list can never drift
// from reality: a session shows up as a tab iff it exists in tmux and carries
// the tag, and its label dies with the session. No separate file to get stale.
// ---------------------------------------------------------------------------
const TAB_TAG = "@twtab";
const TAB_LABEL = "@twlabel";

export interface WebTab {
  /** tmux session name — the immutable id used to attach/kill the session. */
  name: string;
  /** Label shown on the tab; defaults to the session name. */
  displayName: string;
}

/**
 * Mark a session as a web tab so every device shows it. Best-effort, with a
 * few retries: the tag is written right after the pty spawns `tmux
 * new-session`, which may not have registered the session yet, so an immediate
 * set-option can fail with "can't find session" — retry briefly until it sticks.
 */
export function tagWebSession(name: string, attempt = 0): void {
  execFile("tmux", ["set-option", "-t", name, TAB_TAG, "1"], (err) => {
    if (err && attempt < 10) {
      setTimeout(() => tagWebSession(name, attempt + 1), 150);
    }
  });
}

/** Persist a web tab's display label on its tmux session. Best-effort. */
export function setWebTabLabel(name: string, displayName: string): void {
  // Strip control chars (newlines/tabs) so a label can never break the
  // space-delimited parsing in listWebTabs.
  const dn = displayName.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 64) || name;
  execFile("tmux", ["set-option", "-t", name, TAB_LABEL, dn], () => {});
}

/**
 * List the tmux sessions tagged as web tabs, in creation order, each with its
 * display label. Returns `null` when tmux can't be queried (no server / not
 * installed) — same "unknown, keep prior state" contract as
 * {@link listTmuxSessions} — versus `[]` for "queried fine, no tabs".
 */
export function listWebTabs(): Promise<WebTab[] | null> {
  // Space-separated, with the free-text label LAST. We deliberately avoid a TAB
  // (or any control char) separator: under a non-UTF-8 locale — e.g. the bare
  // environment launchd gives the service — tmux sanitizes control characters
  // in -F output to "_", which silently merged every field into one and made
  // this return nothing (so tabs vanished the moment their socket closed).
  // Session names are restricted to [A-Za-z0-9_-] (no spaces) and the tag and
  // created stamp are numeric, so splitting on spaces with the label as the
  // trailing remainder is unambiguous.
  const fmt = [`#{${TAB_TAG}}`, "#{session_created}", "#{session_name}", `#{${TAB_LABEL}}`].join(
    " "
  );
  return new Promise((resolve) => {
    execFile("tmux", ["list-sessions", "-F", fmt], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const rows: { name: string; displayName: string; created: number }[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const parts = line.split(" ");
        if (parts.length < 3) continue;
        const tag = parts[0];
        if (tag !== "1") continue; // only sessions tagged as web tabs
        const name = parts[2];
        if (!name) continue;
        const label = parts.slice(3).join(" ");
        rows.push({
          name,
          displayName: label.trim() ? label : name,
          created: Number(parts[1]) || 0,
        });
      }
      rows.sort((a, b) => a.created - b.created);
      resolve(rows.map(({ name, displayName }) => ({ name, displayName })));
    });
  });
}
