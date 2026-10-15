// Server calls (tab list, adopt, rename, prefs) and the per-device tab cache.

import { TOUCH_DEVICE } from './config.js';
import type { LayoutMode } from './config.js';
import { activeTab, sessions } from './state.js';

export interface SavedTab {
  name: string;
  displayName: string;
  /** Local only: which of the tab's terminals this device had on screen. */
  view?: LayoutMode;
}

export function saveTabs(): void {
  try {
    localStorage.setItem(
      'tw.tabs',
      JSON.stringify(
        sessions.map((s) => ({ name: s.name, displayName: s.displayName, view: s.view })),
      ),
    );
    if (activeTab) localStorage.setItem('tw.activeTab', activeTab.name);
  } catch {
    /* ignore */
  }
  // The tab, not the half of it that has the keys: a second half's name
  // (X__b) is not a tab, and init would find nothing to open by it.
  if (activeTab) savePrefs({ activeTab: activeTab.name });
}

export function loadTabs(): { tabs: SavedTab[]; active: string | null } {
  try {
    const parsed = JSON.parse(localStorage.getItem('tw.tabs') ?? '[]');
    const active = localStorage.getItem('tw.activeTab');
    if (Array.isArray(parsed)) {
      const tabs: SavedTab[] = [];
      for (const item of parsed) {
        // Old format: a bare session-name string. New format: { name, displayName }.
        if (typeof item === 'string') {
          tabs.push({ name: item, displayName: item });
        } else if (item && typeof item === 'object' && typeof item.name === 'string') {
          const dn =
            typeof item.displayName === 'string' && item.displayName.trim().length
              ? item.displayName
              : item.name;
          const view: LayoutMode | undefined =
            item.view === 'one' || item.view === 'two' || item.view === 'both'
              ? item.view
              : undefined;
          tabs.push({ name: item.name, displayName: dn, view });
        }
      }
      return { tabs, active };
    }
  } catch {
    /* ignore */
  }
  return { tabs: [], active: null };
}

// ---------------------------------------------------------------------------
// Cross-device sync: the server holds the authoritative tab list (which
// sessions exist + their display names), so opening the page on any platform
// shows the same tabs. localStorage is now only a per-device cache (offline
// fallback + which tab this device last had focused).
// ---------------------------------------------------------------------------

// Fetch the server's tab list. Returns null (and we keep local state) if the
// server is unreachable or slow, so a flaky network never blanks the tabs.
export async function fetchServerTabs(timeoutMs = 2500): Promise<SavedTab[] | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { tabs?: unknown };
    if (!Array.isArray(data.tabs)) return null;
    const out: SavedTab[] = [];
    for (const item of data.tabs) {
      if (item && typeof item === 'object' && typeof (item as SavedTab).name === 'string') {
        const name = (item as SavedTab).name;
        const dnRaw = (item as SavedTab).displayName;
        const dn = typeof dnRaw === 'string' && dnRaw.trim() ? dnRaw : name;
        out.push({ name, displayName: dn });
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// Best-effort: tell the server a tab was renamed so other devices pick it up.
// The local label is already updated; a failure just delays cross-device sync.
/**
 * Ask the server to re-adopt these sessions as web tabs. The tab list lives on
 * the tmux sessions (a @twtab option) and is written when a tab attaches —
 * which, now that a tab only attaches when you open it, would leave sessions
 * tmux-resurrect restored after a reboot untagged and about to be swept out of
 * the list by the next sync. The server only tags ones that really exist, so a
 * tab closed on another device is not resurrected by this device's cache.
 */
async function adoptOnServer(names: string[]): Promise<void> {
  try {
    await fetch('/api/sessions/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
  } catch {
    /* ignore — the next sync will simply show what the server does know */
  }
}

function postRename(name: string, displayName: string): Promise<unknown> {
  return fetch('/api/sessions/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName }),
  }).catch(() => {
    /* ignore — local UI already reflects the change */
  });
}

export function renameOnServer(name: string, displayName: string): void {
  void postRename(name, displayName);
}

/**
 * Hand back the tabs the server does not list, and put their labels back with
 * them.
 *
 * Both the tab tag and the label are tmux session options, written when a tab
 * attaches or is renamed, and a session can be alive without either: resurrect
 * restores them after a reboot bare, and a tmux server that restarts under a
 * page that is already open does the same. Nothing re-tags them any more —
 * that used to be a side effect of every tab holding a socket.
 *
 * The label needs saying again because the list the server hands back is what
 * the tab strip shows: a tab adopted without it comes back named after its
 * session and overwrites the name you gave it.
 */
export async function readoptTabs(tabs: SavedTab[]): Promise<void> {
  await adoptOnServer(tabs.map((t) => t.name));
  await Promise.all(
    tabs
      .filter((t) => t.displayName && t.displayName !== t.name)
      .map((t) => postRename(t.name, t.displayName))
  );
}

// ---------------------------------------------------------------------------
// UI prefs (font size, key bar, which tab was open) live on the server too.
// localStorage is still written — it is instant and it is what the first paint
// uses — but it cannot be trusted to still be there: in the iOS launcher this
// page runs in a cross-origin iframe, and that storage goes away when the app
// is closed, so every relaunch looked like a first visit. The server copy is
// what actually restores things. Scoped by device class, so a phone's font
// size is not imposed on a desktop.
// ---------------------------------------------------------------------------

const PREF_SCOPE = TOUCH_DEVICE ? 'touch' : 'desktop';

interface UiPrefs {
  activeTab?: string;
  fontSize?: number;
  keybar?: boolean;
}

export async function fetchServerPrefs(timeoutMs = 2500): Promise<UiPrefs | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/prefs?scope=${PREF_SCOPE}`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { prefs?: unknown };
    const prefs = data.prefs;
    if (!prefs || typeof prefs !== 'object') return null;
    return prefs as UiPrefs;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// Nothing is sent until init has read the server's copy and applied it: the
// values in play before that are boot defaults, and writing those back would
// overwrite the very prefs we are about to restore.
let prefsReady = false;
let pendingPrefs: UiPrefs = {};
let prefsTimer = 0;

function prefsBody(): string {
  const body = JSON.stringify({ scope: PREF_SCOPE, ...pendingPrefs });
  pendingPrefs = {};
  return body;
}

function flushPrefs(): void {
  window.clearTimeout(prefsTimer);
  if (!Object.keys(pendingPrefs).length) return;
  void fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: prefsBody(),
    keepalive: true,
  }).catch(() => {
    /* ignore — a lost pref is a cosmetic loss, and the next change retries */
  });
}

// Coalesced: holding A− down, or walking through tabs, is one write.
export function savePrefs(patch: UiPrefs): void {
  if (!prefsReady) return;
  Object.assign(pendingPrefs, patch);
  window.clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(flushPrefs, 400);
}

export function setPrefsReady(ready: boolean): void {
  prefsReady = ready;
}

export function initPrefsBeacon(): void {
  // Closing the app is exactly when the debounce would still be pending, and on
  // iOS pagehide is the last event we get. sendBeacon survives the teardown that
  // a normal fetch would not.
  window.addEventListener('pagehide', () => {
    if (!prefsReady || !Object.keys(pendingPrefs).length) return;
    const body = prefsBody();
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/prefs', blob)) return;
    } catch {
      /* fall through to fetch */
    }
    void fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      /* ignore */
    });
  });
}
