// Entry point (bundled by esbuild.mjs to public/dist/terminal.js): puts the
// page together in the order the single-file client always did, then restores
// the tabs.
//
// The other modules, when they load, only declare things, read the URL and
// localStorage, and build DOM that is not on the page yet. Whatever touches
// the live page — attaching to it, global listeners, timers, the network —
// runs from here, in the order below.
//
// tabs.ts and ui/topbar, ui/keybar and ui/mobile import one another. That is
// safe only because none of them uses another's exports while loading — only
// inside functions that run later — so keep it that way. Everything below them
// (session.ts included) imports nothing above it.

import '@xterm/xterm/css/xterm.css';
import { MAX_FONT, MIN_FONT, TOUCH_DEVICE } from './config.js';
import { buildTopbarShell } from './dom.js';
import { activeTab, currentFont, isActive, sessions, setCurrentFont } from './state.js';
import { initDragDrop, initPasteUpload } from './transfer.js';
import { fetchServerPrefs, fetchServerTabs, initPrefsBeacon, setPrefsReady } from './api.js';
import { initVersionCheck } from './version.js';
import type { SavedTab } from './api.js';
import { initResizeHandling, isKeybarVisible } from './layout.js';
import { buildSelBar } from './ui/selbar.js';
import { setSessionHooks } from './session.js';
import {
  activateSession,
  addSession,
  cached,
  removeLocalSession,
  setDefaultSessionName,
  setTabsReady,
  syncFromServer,
  updateTabDot,
  urlSession,
} from './tabs.js';
import { buildKeybar, setKeybarVisible } from './ui/keybar.js';
import { buildTopbar } from './ui/topbar.js';
import { buildMobile, updateFontVal } from './ui/mobile.js';

setSessionHooks({ updateTabDot, removeLocalSession });
buildTopbarShell(); // #tabs and #controls into #topbar
initPrefsBeacon(); // pagehide: send prefs still waiting on the debounce
buildTopbar(); // the file picker's <input> onto <body>
buildSelBar(); // the selection bar onto <body>
buildKeybar(); // the keys into #keybar
buildMobile(); // the mobile bar, drawer and actions sheet onto <body>
initResizeHandling(); // resize, viewport, frame and fullscreen listeners
initPasteUpload(); // capture-phase paste: files upload
initDragDrop(); // files dropped on #terminal upload
initVersionCheck(); // reload onto a newer build once hidden or idle

// ---------------------------------------------------------------------------
// Init: restore tabs (or start one), restore prefs, activate.
// ---------------------------------------------------------------------------
async function init(): Promise<void> {
  // Both server round-trips start together; the prefs one is awaited further
  // down, just before the tabs are built.
  const prefsPromise = fetchServerPrefs();
  // The server's list, in its order, whenever it answers — even an empty one.
  // This device's cache stands in only when the server can't be reached: a
  // cached tab the server does not list is not a tab any more (re-tagging a
  // restored session is the server's job, from its tab record).
  const server = await fetchServerTabs();
  let initialTabs: SavedTab[] = server ?? cached.tabs.slice();
  if (urlSession && !initialTabs.some((t) => t.name === urlSession)) {
    initialTabs = [{ name: urlSession, displayName: urlSession }, ...initialTabs];
  }
  // Nothing at all: one tab, made on purpose. Never under a cached name the
  // server just said is not a tab, or creating it would make it one again.
  const fallback = initialTabs.length === 0;
  if (fallback) initialTabs = [{ name: 'web', displayName: 'web' }];
  setDefaultSessionName(urlSession ?? initialTabs[0]?.name ?? 'web');

  // The stored prefs land before any tab is built, so a pane is created at the
  // font it will keep and nothing has to be re-fitted afterwards. A device that
  // still has its localStorage has already applied the same values; this only
  // differs on one that lost them (see fetchServerPrefs).
  const prefs = (await prefsPromise) ?? {};
  if (typeof prefs.fontSize === 'number' && Number.isFinite(prefs.fontSize)) {
    setCurrentFont(Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(prefs.fontSize))));
    updateFontVal();
    try {
      // Refill the cache, so a device that does keep its storage paints at the
      // right size before the server has answered.
      localStorage.setItem('tw.fontSize', String(currentFont));
    } catch {
      /* ignore */
    }
  }
  if (typeof prefs.keybar === 'boolean' && prefs.keybar !== isKeybarVisible()) {
    setKeybarVisible(prefs.keybar);
  }

  // Build every tab (creation order is tab order). None of them attaches here:
  // activating one is what opens its socket, on the frame after its pane has
  // been laid out and measured — so a tab attaches at the size it will really
  // have, and a tab nobody opens costs nothing at all.
  //
  // Whether a tab was split is this device's own memory of it — the server has
  // nothing to say about it, and the phone you also read this on wants its own
  // answer. Only the tab you open acts on it, so a split tab you never look at
  // still opens no second session.
  const cachedViews = new Map(cached.tabs.map((t) => [t.name, t.view]));
  for (const t of initialTabs) {
    const s = addSession(t.name, false, t.displayName);
    s.view = cachedViews.get(t.name) ?? 'one';
    // Asked for by name in the URL, or the fallback when there are no tabs:
    // both are tabs being made, not remembered, so they may create their session.
    if (t.name === urlSession || fallback) s.intendCreate();
  }

  // This device's own last focus first, then what the server remembers for its
  // kind of device — which is what is left after a storage wipe.
  const wanted = [urlSession, cached.active, prefs.activeTab].filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  );
  const active = wanted.map((n) => sessions.find((s) => s.name === n)).find(Boolean);
  activateSession(active ?? sessions[0]);

  // Everything restored: from here on, changes are the user's and get saved,
  // and the server's tab list may be synced against ours.
  setPrefsReady(true);
  setTabsReady(true);
}

void init();

// Keep the tab list in sync with the server: when the page regains focus /
// visibility, and on a light interval while visible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    wakeOnScreen();
    void syncFromServer();
  }
});

// The terminals on screen check their connections the moment the page comes
// back (see Session.wake): after a phone sleeps, the socket is the likeliest
// thing to have died, and the person who just picked it up is about to type.
// The rest keep to their usual heartbeat and backoff.
function wakeOnScreen(): void {
  if (!activeTab) return;
  for (const s of [activeTab, activeTab.mate]) {
    if (s && isActive(s)) s.wake();
  }
}
window.addEventListener('pageshow', wakeOnScreen);
window.addEventListener('online', wakeOnScreen);
window.addEventListener('focus', () => void syncFromServer());
setInterval(() => {
  if (document.visibilityState === 'visible') void syncFromServer();
}, 5000);

// Default: show the key bar on touch devices, hidden on desktop (unless saved).
const keybarDefault = (() => {
  try {
    const v = localStorage.getItem('tw.keybar');
    if (v !== null) return v === '1';
  } catch {
    /* ignore */
  }
  return TOUCH_DEVICE;
})();
setKeybarVisible(keybarDefault);
