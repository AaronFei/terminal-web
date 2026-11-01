// GET /api/sessions/inventory: every tmux session on the server's socket, tab
// or not, with what it is running and how much memory that takes.
//
// The tab list (/api/sessions) shows only sessions tagged as web tabs. Anything
// else — a session a tmux-resurrect restore brought back bare, one opened from
// a shell — keeps running with no way to see or close it from the page. This
// is what the Sessions panel (web/sessions-panel.ts) lists them from. See
// "Every session is visible somewhere" in docs/ARCHITECTURE.md for the format.

import { execFile } from "node:child_process";

import { listAllPanes, listSessionDetails } from "./tmux.js";
import type { WebTab } from "./tmux.js";

export interface InventoryEntry {
  name: string;
  /** The tab's label for a tab, else the name. */
  displayName: string;
  /** "tab" = what /api/sessions lists (a second half: whatever its first half is). */
  kind: "tab" | "hidden";
  /** Only on a second half `X__b` whose first half `X` exists. */
  mateOf?: string;
  attached: number;
  created: number;
  activity: number;
  /** Current command of the session's first pane. */
  command: string;
  /** RSS of every pane process and all its descendants, in KB; null if ps failed. */
  rssKB: number | null;
}

const MATE_SUFFIX = "__b";
const PS_TIMEOUT_MS = 3000;

interface ProcRow {
  ppid: number;
  rss: number;
}

/**
 * Every process's parent and RSS (KB), from one `ps`. The same flags work on
 * macOS and on Linux procps, and both report RSS in KB. Null on any failure,
 * a timeout included.
 */
function readProcessTable(): Promise<Map<number, ProcRow> | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,rss="],
      { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const procs = new Map<number, ProcRow>();
        for (const line of stdout.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const pid = Number(parts[0]);
          const ppid = Number(parts[1]);
          const rss = Number(parts[2]);
          if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
          procs.set(pid, { ppid, rss: Number.isFinite(rss) && rss > 0 ? rss : 0 });
        }
        resolve(procs.size ? procs : null);
      }
    );
  });
}

/** The RSS of `roots` and every process descended from them, each counted once. */
function treeRss(roots: number[], procs: Map<number, ProcRow>, children: Map<number, number[]>): number {
  const seen = new Set<number>();
  const stack = [...roots];
  let total = 0;
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += procs.get(pid)?.rss ?? 0;
    for (const kid of children.get(pid) ?? []) stack.push(kid);
  }
  return total;
}

/**
 * The inventory, or null when tmux can't be asked (no server, not installed).
 *
 * `webTabs` is the very list /api/sessions answers with, so a session is a
 * "tab" here exactly when the tab bar shows it. The second half of a split is
 * left out of that list while its first half is there; here it is listed, as
 * `mateOf` that first half and of the same kind.
 */
export async function sessionInventory(
  webTabs: () => Promise<WebTab[] | null>
): Promise<InventoryEntry[] | null> {
  const [tabs, details, panes, procs] = await Promise.all([
    webTabs(),
    listSessionDetails(),
    listAllPanes(),
    readProcessTable(),
  ]);
  if (details === null || tabs === null) return null;

  const tabByName = new Map(tabs.map((t) => [t.name, t]));
  const existing = new Set(details.map((d) => d.name));

  // Pane pids and the first pane's command, per session.
  const panePids = new Map<string, number[]>();
  const firstCommand = new Map<string, string>();
  for (const p of panes ?? []) {
    const list = panePids.get(p.session);
    if (list) list.push(p.pid);
    else panePids.set(p.session, [p.pid]);
    if (!firstCommand.has(p.session)) firstCommand.set(p.session, p.command);
  }

  let children: Map<number, number[]> | null = null;
  if (procs) {
    children = new Map();
    for (const [pid, row] of procs) {
      const list = children.get(row.ppid);
      if (list) list.push(pid);
      else children.set(row.ppid, [pid]);
    }
  }

  return details.map((d) => {
    let kind: InventoryEntry["kind"] = tabByName.has(d.name) ? "tab" : "hidden";
    let mateOf: string | undefined;
    const base = d.name.endsWith(MATE_SUFFIX) ? d.name.slice(0, -MATE_SUFFIX.length) : null;
    // A second half the tab list shows on its own (its first half is not a
    // tab, yet this one is tagged or connected) is a tab of its own there, so
    // it is one here too and is not folded into a first half the tab bar
    // doesn't have.
    if (base && existing.has(base) && !tabByName.has(d.name)) {
      mateOf = base;
      kind = tabByName.has(base) ? "tab" : "hidden";
    }
    const tab = kind === "tab" && !mateOf ? tabByName.get(d.name) : undefined;
    const pids = panePids.get(d.name);
    const rssKB = procs && children && pids ? treeRss(pids, procs, children) : null;
    return {
      name: d.name,
      displayName: tab?.displayName || d.name,
      kind,
      ...(mateOf ? { mateOf } : {}),
      attached: d.attached,
      created: d.created,
      activity: d.activity,
      command: firstCommand.get(d.name) ?? "",
      rssKB,
    };
  });
}
