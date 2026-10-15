import { execFile, execFileSync } from "node:child_process";
import type { ExecFileSyncOptions } from "node:child_process";
import * as pty from "node-pty";

// ---------------------------------------------------------------------------
// Running tmux.
//
// Every tmux the server starts goes through runTmuxCb / runTmuxSync /
// spawnTmuxPty below — nothing else in the server names the binary. That is
// what makes TERMINAL_WEB_TMUX_SOCKET safe to rely on: with it set, every one
// of them talks to `tmux -L <socket>` and none can reach the user's own server,
// where Claude Code sessions with real work in them are running.
// ---------------------------------------------------------------------------

/** "" = tmux's default socket (production); otherwise a `-L` socket name. */
let tmuxSocket = "";

/** Point every tmux call at `-L socket` ("" = the default socket). Call once, at startup. */
export function setTmuxSocket(socket: string): void {
  tmuxSocket = socket;
}

function tmuxArgv(args: string[]): string[] {
  return tmuxSocket ? ["-L", tmuxSocket, ...args] : args;
}

/**
 * The environment a tmux child runs with. On a test socket, TMUX and TMUX_PANE
 * go: the server under test may well have been started from inside tmux, and
 * a client that inherits $TMUX treats itself as nested in that (real) server.
 * The -L should win over it, but nothing here should hinge on that. On the
 * default socket the env is left exactly as it was.
 */
function tmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!tmuxSocket) return env;
  const out = { ...env };
  delete out.TMUX;
  delete out.TMUX_PANE;
  return out;
}

type ExecCallback = (err: Error | null, stdout: string) => void;

/** execFile("tmux", args) on the configured socket; stdout as utf8. */
function runTmuxCb(args: string[], cb: ExecCallback): void {
  execFile("tmux", tmuxArgv(args), { env: tmuxEnv(), encoding: "utf8" }, (err, stdout) =>
    cb(err, stdout)
  );
}

/** execFileSync("tmux", args) on the configured socket. */
function runTmuxSync(args: string[], opts: ExecFileSyncOptions = {}): void {
  execFileSync("tmux", tmuxArgv(args), { ...opts, env: tmuxEnv(opts.env) });
}

/** A pty running a tmux client on the configured socket (see tmuxArgs). */
export function spawnTmuxPty(args: string[], opts: pty.IPtyForkOptions): pty.IPty {
  return pty.spawn("tmux", tmuxArgv(args), { ...opts, env: tmuxEnv(opts.env) });
}

/** Run tmux; resolve its stdout, or null if it failed. Never throws. */
function runTmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    runTmuxCb(args, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Run tmux; resolve the error (null on success). Never throws. */
export function runTmuxStatus(args: string[]): Promise<Error | null> {
  return new Promise((resolve) => {
    runTmuxCb(args, (err) => resolve(err));
  });
}

// ---------------------------------------------------------------------------
// Session names and targets.
// ---------------------------------------------------------------------------

const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A requested tmux session name, exactly as sent, or null if it is not one.
 *
 * Names are [A-Za-z0-9_-], 1..64 long, and are never cleaned up into something
 * that is: this used to strip what didn't fit, cut the rest to 64 and fall back
 * to "web" on nothing, so a request could act on a session it never named. A
 * kill sent for "x y" killed "xy"; the second half `X__b` of a 64-character
 * tab, cut to 64, was `X` — the first half; and anything empty landed on "web".
 */
export function sessionName(raw: unknown): string | null {
  return typeof raw === "string" && SESSION_NAME_RE.test(raw) ? raw : null;
}

/**
 * `-t` targets. `=` makes tmux match the name exactly; without it tmux falls
 * back to a unique-prefix match, so killing "dev" after it is already gone
 * would kill "devops". The session form is for commands whose -t is a
 * target-session (kill-session, has-session); the `:` form names that
 * session's current window/pane, for those whose -t is a target-pane
 * (display-message — and set-option: since options can be pane-scoped its -t
 * is a pane target, which `=name` alone fails to resolve with "no such
 * session", while `=name:` still sets the option on the session).
 */
export function sessionTarget(name: string): string {
  return `=${name}`;
}
export function paneTarget(name: string): string {
  return `=${name}:`;
}

/**
 * Build the argv for the tmux client a tab's pty runs (see spawnTmuxPty).
 *
 * Uses `new-session -A` so it attaches to an existing session of the same name
 * or creates it if missing — the core of the resume behavior. The session is
 * assumed to have been checked by the caller (see sessionName). `-s` takes a
 * name, not a target, so it has no `=` to add.
 *
 * `-u` forces tmux to treat the client as UTF-8 capable regardless of the
 * locale it detects, so CJK/wide characters render correctly instead of being
 * replaced with "_" placeholders.
 */
export function tmuxArgs(session: string, confPath: string, startDir?: string): string[] {
  // -c only when the caller knows the session is being made: on an existing one
  // `-A` hands it to attach-session, which would reset the session's default
  // directory instead.
  const dir = startDir ? ["-c", startDir] : [];
  return ["-u", "-f", confPath, "new-session", "-A", "-s", session, ...dir];
}

/**
 * Where a new second half of a split should start: the directory the first
 * half's active pane is in right now. Null when that cannot be told — the first
 * half is gone, or the second half already exists (it keeps its own).
 */
export function mateStartDir(mate: string, base: string): Promise<string | null> {
  return new Promise((resolve) => {
    runTmuxCb(["has-session", "-t", sessionTarget(mate)], (err) => {
      if (!err) {
        resolve(null); // already there: attaching must not move it
        return;
      }
      runTmuxCb(
        ["display-message", "-p", "-t", paneTarget(base), "#{pane_current_path}"],
        (err2, stdout) => {
          const dir = err2 ? "" : stdout.trim();
          resolve(dir.startsWith("/") ? dir : null);
        }
      );
    });
  });
}

/** The active pane's working directory in a session, or null if unknown. */
export async function sessionCwd(name: string): Promise<string | null> {
  const out = await runTmux([
    "display-message",
    "-p",
    "-t",
    paneTarget(name),
    "#{pane_current_path}",
  ]);
  return out === null ? null : out.trim() || null;
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
    runTmuxCb(
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
    runTmuxSync(["-V"], { stdio: "ignore" });
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
  runTmuxCb(["set-option", "-t", paneTarget(name), TAB_TAG, "1"], (err) => {
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
  runTmuxCb(["set-option", "-t", paneTarget(name), TAB_LABEL, dn], () => {});
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
    runTmuxCb(["list-sessions", "-F", fmt], (err, stdout) => {
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

// ---------------------------------------------------------------------------
// Forcing a repaint.
//
// tmux only ever sends differences: it keeps a model of what each client's
// screen holds and skips anything it believes is already right. That makes a
// divergence permanent — once the browser's grid and tmux's model disagree,
// nothing corrects it. It shows up as a pane divider drawn a column or two off
// on a few rows, in whichever colour it had at the time (a border that is grey
// on some rows and green on others is the giveaway: tmux paints the whole
// border in one style per frame, so those rows are leftovers from different
// repaints). refresh-client throws that model away and redraws everything.
// ---------------------------------------------------------------------------

/**
 * The tty of the tmux client a pty is running, found by matching the pty's pid:
 * node-pty spawns the `tmux new-session -A` client itself, so the pid it
 * reports IS the client's. Null when tmux can't be asked, or the client is gone.
 */
export async function findClientTty(pid: number): Promise<string | null> {
  const out = await runTmux(["list-clients", "-F", "#{client_pid} #{client_tty}"]);
  if (out === null) return null;
  for (const line of out.split("\n")) {
    const [clientPid, tty] = line.trim().split(" ");
    if (tty && Number(clientPid) === pid) return tty;
  }
  return null;
}

/** Redraw a client's whole screen, absolutely, from tmux's own grid. */
export async function refreshClient(tty: string): Promise<void> {
  await runTmux(["refresh-client", "-t", tty]);
}
