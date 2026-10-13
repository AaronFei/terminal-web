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
 * Socket selected at startup. Empty means tmux's default socket — that is the
 * production server, so tests must set this to a scratch `-L` name before any
 * tmux command runs. Every CLI invocation and every pty argv goes through
 * {@link tmuxCommand} / {@link tmuxArgs} so a configured socket cannot be
 * forgotten on one call.
 */
let tmuxSocketName = "";

export function configureTmuxSocket(name: string): void {
  if (name !== "" && !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      `Refusing tmux socket name "${name}": must match [A-Za-z0-9_-]{1,64}, or be empty for the default socket.`
    );
  }
  tmuxSocketName = name;
}

export function currentTmuxSocketName(): string {
  return tmuxSocketName;
}

/** `-L <name>` when a socket is configured, else nothing (default socket). */
export function tmuxSocketArgs(): string[] {
  return tmuxSocketName ? ["-L", tmuxSocketName] : [];
}

/**
 * Flags that belong before the tmux subcommand: force UTF-8, and the socket
 * when one is configured. `-L` is what keeps a test off the default server
 * even if `TMUX` is set in the environment (this process may itself be
 * attached to the production session).
 */
export function tmuxCommandPrefix(): string[] {
  return ["-u", ...tmuxSocketArgs()];
}

/** argv for `execFile("tmux", tmuxCommand([...]))`. */
export function tmuxCommand(args: string[]): string[] {
  return [...tmuxCommandPrefix(), ...args];
}

/**
 * Environment for tmux children. A UTF-8 locale is required so `-F` output
 * keeps real separators (tmux rewrites control characters to "_" in the C
 * locale). When a socket is configured, drop `TMUX` so a forgotten `-L` is
 * not the only thing standing between a test and the outer session — the
 * argv still carries `-L`; this is the second lock.
 */
export function tmuxExecEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tmuxSocketName) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  const hasUtf8 = (value: string | undefined): boolean =>
    typeof value === "string" && /utf-?8/i.test(value);
  if (!hasUtf8(env.LC_ALL) && !hasUtf8(env.LC_CTYPE) && !hasUtf8(env.LANG)) {
    env.LANG = "en_US.UTF-8";
  }
  return env;
}

function execTmux(
  args: string[],
  cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
): void {
  execFile("tmux", tmuxCommand(args), { env: tmuxExecEnv() }, (err, stdout, stderr) => {
    cb(err as NodeJS.ErrnoException | null, stdout ?? "", stderr ?? "");
  });
}

/** Run tmux; resolve stdout, or null if it failed. Never throws. */
function runTmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execTmux(args, (err, stdout) => resolve(err ? null : stdout));
  });
}

export interface TmuxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run tmux on the configured socket. Never throws. */
export function runTmuxResult(args: string[]): Promise<TmuxResult> {
  return new Promise((resolve) => {
    execTmux(args, (err, stdout, stderr) => {
      const text = `${stderr}\n${err?.message ?? ""}`;
      resolve({ ok: !err, stdout, stderr: text });
    });
  });
}

/**
 * Build the argv passed to the `tmux` binary (node-pty spawns "tmux" + these).
 *
 * Uses `new-session -A` so it attaches to an existing session of the same name
 * or creates it if missing — the core of the resume behavior. The session is
 * assumed to already be sanitized by the caller.
 *
 * Not used in window mode. Window mode attaches with {@link tmuxAttachArgs}
 * and must not create a missing session.
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
  return [...tmuxCommandPrefix(), "-f", confPath, "new-session", "-A", "-s", session, ...dir];
}

/**
 * Attach to a session that must already exist.
 *
 * No `-A`, no `new-session`, no `-f`. `-f` starts a server when none is
 * running; window mode must not create a server or a session. If `session`
 * is missing, the tmux client exits and nothing is created.
 */
export function tmuxAttachArgs(session: string): string[] {
  return [...tmuxCommandPrefix(), "attach-session", "-t", `=${session}`];
}

/**
 * Where a new second half of a split should start: the directory the first
 * half's active pane is in right now. Null when that cannot be told — the first
 * half is gone, or the second half already exists (it keeps its own).
 */
export function mateStartDir(mate: string, base: string): Promise<string | null> {
  return new Promise((resolve) => {
    execTmux(["has-session", "-t", `=${mate}`], (err) => {
      if (!err) {
        resolve(null); // already there: attaching must not move it
        return;
      }
      execTmux(
        ["display-message", "-p", "-t", `=${base}:`, "#{pane_current_path}"],
        (err2, stdout) => {
          const dir = err2 ? "" : stdout.trim();
          resolve(dir.startsWith("/") ? dir : null);
        }
      );
    });
  });
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
    execTmux(["list-sessions", "-F", "#{session_name}"], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const names = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      resolve(names);
    });
  });
}

/**
 * Check whether the `tmux` binary is available on PATH.
 *
 * Returns true if `tmux -V` succeeds, false otherwise. Never throws.
 * This probes the binary only — it does not talk to a server, so it does not
 * take a socket flag.
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
//
// Window mode does not use these. Its tabs are windows of the fixed main
// session, identified by #{window_id}.
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
  execTmux(["set-option", "-t", name, TAB_TAG, "1"], (err) => {
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
  execTmux(["set-option", "-t", name, TAB_LABEL, dn], () => {});
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
    execTmux(["list-sessions", "-F", fmt], (err, stdout) => {
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
// Windows of the fixed main session.
//
// A tab is a tmux window, not a session. The id is #{window_id} (`@12`), which
// stays put when windows are renumbered. The index is display order only.
// ---------------------------------------------------------------------------

const WINDOW_ID_RE = /^@\d+$/;

export interface TmuxWindow {
  /** Stable tmux window id, e.g. `@12`. */
  id: string;
  /** Current index. Not an identity — it changes when earlier windows close. */
  index: number;
  /** Actual tmux window name (`rename-window`), not a browser-only label. */
  name: string;
  /** Authoritative shared selection: exactly one window is active. */
  active: boolean;
}

export function sanitizeWindowId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return WINDOW_ID_RE.test(raw) ? raw : null;
}

/**
 * A window name safe to pass as `rename-window` / `new-window -n` argv.
 * Control characters are stripped. A leading `-` is rejected so it cannot be
 * parsed as a flag. Empty means "no name" (caller omits `-n`).
 */
export function sanitizeWindowName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 64);
  if (!name || name.startsWith("-")) return null;
  return name;
}

function classifySessionError(text: string): "missing" | "unknown" {
  const t = text.toLowerCase();
  if (
    t.includes("can't find session") || t.includes("session not found") ||
    t.includes("no server running") ||
    (t.includes("error connecting to") &&
      (t.includes("no such file or directory") || t.includes("connection refused")))
  ) return "missing";
  return "unknown";
}

/**
 * Whether `session` exists on the configured socket.
 *
 * `true` / `false` are answers from a tmux server. `null` means the server
 * could not be asked (no server, tmux missing, anything else) — callers must
 * not treat that as "missing, so create it".
 */
export function sessionExists(session: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execTmux(["has-session", "-t", `=${session}`], (err, _stdout, stderr) => {
      if (!err) {
        resolve(true);
        return;
      }
      const kind = classifySessionError(`${stderr}\n${err.message}`);
      resolve(kind === "missing" ? false : null);
    });
  });
}

/** Windows of `session`, index order. `null` if tmux could not be asked. */
export function listSessionWindows(session: string): Promise<TmuxWindow[] | null> {
  // Name last: it may contain spaces. Id, index and the active flag cannot.
  const fmt = "#{window_id} #{window_index} #{window_active} #{window_name}";
  return new Promise((resolve) => {
    execTmux(["list-windows", "-t", `=${session}`, "-F", fmt], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const windows: TmuxWindow[] = [];
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const m = /^(?<id>@\d+) (?<index>\d+) (?<active>[01])(?: (?<name>.*))?$/.exec(line);
        if (!m?.groups) continue;
        windows.push({
          id: m.groups.id,
          index: Number(m.groups.index),
          name: (m.groups.name ?? "").trim() || m.groups.id,
          active: m.groups.active === "1",
        });
      }
      windows.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
      resolve(windows);
    });
  });
}

export interface SessionWindows {
  /**
   * `true` session is there, `false` the server said it is missing, `null`
   * tmux could not be asked. Never a signal to create the session.
   */
  present: boolean | null;
  /** `null` when the list is unknown (keep the client's previous tabs). */
  windows: TmuxWindow[] | null;
  activeId: string | null;
}

/** List windows without ever creating the session. */
export async function describeSessionWindows(session: string): Promise<SessionWindows> {
  const present = await sessionExists(session);
  if (present !== true) {
    return { present, windows: present === false ? [] : null, activeId: null };
  }
  const windows = await listSessionWindows(session);
  if (!windows) return { present: true, windows: null, activeId: null };
  return {
    present: true,
    windows,
    activeId: windows.find((w) => w.active)?.id ?? null,
  };
}

/**
 * `new-window -t <session>`. Does not create the session: if it is missing,
 * tmux fails and this returns null. The new window becomes current — that is
 * ordinary tmux, and it changes the shared selection for every client.
 */
export async function createSessionWindow(
  session: string,
  name?: string
): Promise<TmuxWindow | null> {
  const args = ["new-window", "-t", `=${session}`, "-P", "-F", "#{window_id}"];
  if (name) args.push("-n", name);
  const created = await runTmuxResult(args);
  if (!created.ok) return null;
  const id = sanitizeWindowId(created.stdout.trim());
  const listed = await listSessionWindows(session);
  return listed?.find((w) => w.id === id) ?? null;
}

type WindowCommandOutcome = "done" | "refused" | "failed";

/** Quote a literal argument for tmux's command parser, not for a shell. */
function quoteTmuxArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a mutation in the requested session's window context. An @id may be
 * linked into several sessions; using only @id can select another session.
 * tmux also falls back to the current window for =session:@unlinked. Check
 * BOTH identities in the same tmux command queue as the mutation, so an
 * external unlink after the HTTP membership check cannot mutate a fallback.
 */
async function runSessionWindowCommand(
  session: string,
  id: string,
  command: "rename-window" | "select-window" | "kill-window",
  argument?: string
): Promise<WindowCommandOutcome> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session) || !WINDOW_ID_RE.test(id)) return "failed";
  const target = `=${session}:${id}`;
  const guard = `#{&&:#{==:#{session_name},${session}},#{==:#{window_id},${id}}}`;
  const refused = "terminal-web-window-not-member";
  const result = await runTmuxResult([
    "if-shell", "-F", "-t", target, guard,
    `${command} -t ${target}${argument === undefined ? "" : ` ${quoteTmuxArg(argument)}`}`,
    `display-message -p ${refused}`,
  ]);
  if (!result.ok) return "failed";
  return result.stdout.trim() === refused ? "refused" : "done";
}

export async function renameSessionWindow(
  session: string,
  id: string,
  name: string
): Promise<boolean> {
  return (await runSessionWindowCommand(session, id, "rename-window", name)) === "done";
}

export type WindowKillOutcome = "killed" | "refused" | "failed";

/** Explicit final-window termination is allowed; it ends the session. */
export async function killSessionWindow(
  session: string,
  id: string
): Promise<WindowKillOutcome> {
  const outcome = await runSessionWindowCommand(session, id, "kill-window");
  return outcome === "done" ? "killed" : outcome;
}

export async function selectSessionWindow(session: string, id: string): Promise<boolean> {
  return (await runSessionWindowCommand(session, id, "select-window")) === "done";
}

/** Active pane cwd of a session, using the configured socket. */
export async function sessionPaneCwd(session: string): Promise<string | null> {
  const result = await runTmuxResult([
    "display-message",
    "-p",
    "-t",
    `=${session}:`,
    "-F",
    "#{pane_current_path}",
  ]);
  if (!result.ok) return null;
  const dir = result.stdout.trim();
  return dir.startsWith("/") ? dir : null;
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
 * node-pty spawns the tmux client itself, so the pid it reports IS the
 * client's. Null when tmux can't be asked, or the client is gone.
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
