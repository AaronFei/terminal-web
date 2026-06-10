import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface TabEntry {
  /** tmux session name — the immutable id used to attach/kill the session. */
  name: string;
  /** Label shown on the tab; defaults to the session name. */
  displayName: string;
}

/**
 * Server-side, persistent list of the tabs opened from the web UI.
 *
 * This is the cross-device source of truth: every browser hitting this server
 * reads the same list, so tabs (and their display names) stay in sync across
 * platforms. Only the display name lives here — the tmux session is never
 * renamed, so closing a tab still kills the original session.
 *
 * The file is tiny and writes are infrequent, so the whole list is kept in
 * memory; writes are serialized through one promise chain and land atomically
 * (temp file + rename) so a concurrent read never sees a half-written file.
 */
export class TabsStore {
  private tabs: TabEntry[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** Load the store from disk once at startup (missing/corrupt -> empty). */
  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const list = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
      const out: TabEntry[] = [];
      for (const item of list) {
        if (!item || typeof item.name !== "string" || !item.name) continue;
        if (out.some((t) => t.name === item.name)) continue; // de-dupe
        const dn =
          typeof item.displayName === "string" && item.displayName.trim()
            ? item.displayName
            : item.name;
        out.push({ name: item.name, displayName: dn });
      }
      this.tabs = out;
    } catch {
      this.tabs = [];
    }
  }

  /** A copy of the tracked tabs, in insertion order. */
  list(): TabEntry[] {
    return this.tabs.map((t) => ({ ...t }));
  }

  /** Track a session if not already known (preserves insertion order). */
  register(name: string): void {
    if (this.tabs.some((t) => t.name === name)) return;
    this.tabs.push({ name, displayName: name });
    this.persist();
  }

  /** Update a tab's display label; registers the session if it's unknown. */
  rename(name: string, displayName: string): void {
    const dn = displayName.trim().slice(0, 64) || name;
    const t = this.tabs.find((x) => x.name === name);
    if (t) {
      if (t.displayName === dn) return;
      t.displayName = dn;
    } else {
      this.tabs.push({ name, displayName: dn });
    }
    this.persist();
  }

  /** Forget a session (its tab was closed / its tmux session killed). */
  remove(name: string): void {
    const next = this.tabs.filter((t) => t.name !== name);
    if (next.length === this.tabs.length) return;
    this.tabs = next;
    this.persist();
  }

  private persist(): void {
    const snapshot = JSON.stringify({ tabs: this.tabs }, null, 2);
    const tmp = this.filePath + ".tmp";
    this.writeChain = this.writeChain
      .then(async () => {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
        await fsp.rename(tmp, this.filePath);
      })
      .catch((err) => {
        console.error("[tabs] failed to persist store:", err);
      });
  }
}
