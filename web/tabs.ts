import { TOUCH_DEVICE, isMateName, params, primaryNameOf, sanitizeName } from './config.js';
import { addBtn, tabsEl } from './dom.js';
import {
  CLOSE_GUARD_MS,
  activeSession,
  activeTab,
  recentlyClosed,
  sessions,
  setActiveSession,
  setActiveTab,
} from './state.js';
import { reflectActiveStatus } from './status.js';
import { domPrompt } from './overlays.js';
import { fetchServerTabs, loadTabs, readoptTabs, renameOnServer, saveTabs } from './api.js';
import { layOutTab, refreshLayoutUI } from './layout.js';
import { hideSelectionBar } from './ui/selbar.js';
import { Session } from './session.js';
import { drawerDots, refreshMobileTitle, refreshMobileUI } from './ui/mobile.js';

// ---------------------------------------------------------------------------
// Tab / session manager
// ---------------------------------------------------------------------------
export function updateTabDot(s: Session): void {
  if (s.isMate) return; // no tab of its own to report on
  // The strip's dot and the drawer's, changed where they are. Re-rendering the
  // drawer for this rebuilt the list under the finger on every connect and
  // disconnect, and a tap that landed as it did was lost.
  for (const dot of [s.tabDot, drawerDots.get(s)]) {
    dot?.classList.toggle('connected', s.connected);
    // A tab nobody has opened yet is not "disconnected" — there is nothing
    // wrong with it, it just hasn't attached. Hollow dot rather than a grey one.
    dot?.classList.toggle('idle', !s.started);
  }
  refreshMobileTitle();
}

// How far a finger may move between landing and lifting and still count as a
// tap. Past it, it was a swipe — scrolling a list — and picks nothing.
const TAP_SLOP_PX = 10;

/**
 * Run `fn` on a tap, and never on a swipe that starts on `el`.
 *
 * Acting on pointerdown (what the session drawer used to do) picks whatever the
 * finger lands on, and its preventDefault stops the list from scrolling at all:
 * trying to scroll to a session selected the first one you touched. Waiting for
 * pointerup is not enough by itself either — a browser does not always turn a
 * short drag into a scroll (and fire pointercancel) before the finger lifts. So
 * a tap is a lift close to where it landed, with `scroller`, if given, not
 * having moved in between.
 */
export function onTap(el: HTMLElement, fn: (e: PointerEvent) => void, scroller?: HTMLElement): void {
  let start: { id: number; x: number; y: number; left: number; top: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    start = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: scroller?.scrollLeft ?? 0,
      top: scroller?.scrollTop ?? 0,
    };
  });
  el.addEventListener('pointercancel', () => {
    start = null;
  });
  el.addEventListener('pointerup', (e) => {
    const s0 = start;
    start = null;
    if (!s0 || s0.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) > TAP_SLOP_PX) return;
    if (scroller && (scroller.scrollLeft !== s0.left || scroller.scrollTop !== s0.top)) return;
    tapped = true;
    fn(e);
  });
  // A tap that closes the drawer uncovers the terminal, and the mouse events a
  // browser synthesizes after a touch would land on it — focusing it, which on
  // a phone raises the keyboard. touchend comes after pointerup and cancelling
  // it cancels those; it is too late to affect a scroll, which is over.
  let tapped = false;
  el.addEventListener(
    'touchend',
    (e) => {
      if (tapped && e.cancelable) e.preventDefault();
      tapped = false;
    },
    { passive: false },
  );
}

function buildTab(s: Session): void {
  const tab = document.createElement('div');
  tab.className = 'tab';
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = s.displayName;
  label.title = `session: ${s.name} (double-click to rename)`;
  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = 'Close tab & kill session';
  tab.append(dot, label, close);

  // Single tap activates; a second tap within 350ms renames. On a tap only (see
  // onTap), and WITHOUT preventDefault, so a sideways drag scrolls the strip
  // instead of picking the tab it started on. (The old pointerdown+preventDefault
  // cancelled the pan, making the strip unscrollable once your finger landed on
  // a tab.) touch-action:manipulation on .tab keeps the strip pannable and drops
  // the double-tap-to-zoom.
  let lastTap = 0;
  onTap(tab, (e) => {
    if (e.target === close) return; // the × has its own handler
    const now = performance.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      promptRenameSession(s);
      return;
    }
    lastTap = now;
    activateSession(s);
  }, tabsEl);
  onTap(close, (e) => {
    e.stopPropagation();
    confirmCloseSession(s);
  }, tabsEl);

  s.tabEl = tab;
  s.tabLabel = label;
  s.tabDot = dot;
  tabsEl.insertBefore(tab, addBtn); // keep the "+" button last
  updateTabDot(s);
  refreshMobileUI();
}

// Tabs built here moments ago. A tab attaches only when it is first looked at,
// so the server may not know about a brand-new one yet; without this the next
// sync would read its absence from the server's list as "closed on another
// device" and drop it.
const recentlyCreated = new Map<string, number>();
const CREATE_GUARD_MS = 6000;

export function addSession(name: string, makeActive: boolean, displayName?: string): Session {
  let s = sessions.find((x) => x.name === name);
  if (!s) {
    s = new Session(name, displayName);
    sessions.push(s);
    buildTab(s);
    recentlyCreated.set(name, performance.now());
  } else if (displayName && displayName.trim() && displayName.trim() !== s.displayName) {
    setDisplayName(s, displayName.trim());
  }
  if (makeActive) activateSession(s);
  saveTabs();
  return s;
}

export function activateSession(s: Session): void {
  if (activeTab && activeTab !== s) {
    activeTab.setShown(false);
    activeTab.mate?.setShown(false);
  }
  setActiveTab(s);
  // Whatever had the keys belonged to the tab we just left.
  setActiveSession(s);
  layOutTab(s);
  for (const x of sessions) x.tabEl?.classList.toggle('active', x === s);
  // With many tabs the active one can sit off-screen in the horizontal strip
  // (e.g. after picking it from the drawer); scroll it back into view. inline/
  // block: 'nearest' only scrolls #tabs horizontally, never the page/terminal.
  s.tabEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  hideSelectionBar(); // a selection belongs to the tab it was made in
  // On touch (phones / iOS PWA), don't auto-focus the terminal when a tab
  // becomes active: focusing xterm's hidden textarea pops up the soft keyboard,
  // so every tab switch forced it open and the user had to dismiss it each
  // time. Tapping the terminal still focuses it (and raises the keyboard) when
  // the user actually wants to type. Desktop keeps the immediate focus so you
  // can type right after switching.
  if (!TOUCH_DEVICE) requestAnimationFrame(() => activeSession?.focus());
  reflectActiveStatus();
  refreshMobileUI();
  refreshLayoutUI();
  saveTabs();
}

// Ask before killing a session: closing a tab terminates its tmux session and
// any programs running in it, so make the user confirm first.
export function confirmCloseSession(s: Session): void {
  if (document.querySelector('.confirm-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay confirm-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box confirm-box';
  const label = document.createElement('div');
  label.className = 'paste-label';
  const strong = document.createElement('b');
  strong.textContent = s.displayName;
  const sessionNote = s.displayName === s.name ? '' : ` (tmux session "${s.name}")`;
  label.append(
    'Close ',
    strong,
    `${sessionNote}? This kills its tmux session and ends any programs running in it.`,
  );
  const row = document.createElement('div');
  row.className = 'paste-row';
  const cancel = document.createElement('button');
  cancel.className = 'tb-btn';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.className = 'tb-btn danger';
  confirm.type = 'button';
  confirm.textContent = 'Close & kill';
  row.append(cancel, confirm);
  box.append(label, row);
  overlay.append(box);
  document.body.append(overlay);
  window.setTimeout(() => confirm.focus(), 0);

  const close = (): void => {
    overlay.remove();
    activeSession?.focus();
  };
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', () => {
    close();
    closeSession(s);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

/**
 * The tab that appears when the last one goes — made on purpose, so it may
 * create its session. Never under a name that was just closed, though: that is
 * how a page waking up with only a closed tab would bring it straight back.
 */
function addFallbackTab(): void {
  const name = recentlyClosed.has(defaultSessionName) ? nextSessionName() : defaultSessionName;
  addSession(name, true).intendCreate();
}

function closeSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  // Guard against a server sync that raced the kill re-adding this tab.
  recentlyClosed.set(s.name, performance.now());
  // Closing a tab kills its tmux session for good (its programs are terminated).
  s.kill();
  dropTab(s, idx);
  if (sessions.length === 0) addFallbackTab();
  refreshMobileUI();
  saveTabs();
}

function nextSessionName(): string {
  const used = new Set(sessions.map((s) => s.name));
  for (const c of ['web', 'work', 'dev', 'scratch']) if (!used.has(c)) return c;
  let i = 2;
  while (used.has(`s${i}`)) i += 1;
  return `s${i}`;
}

export async function promptAddSession(): Promise<void> {
  const suggestion = nextSessionName();
  const raw = await domPrompt({
    label: 'New session name:',
    value: suggestion,
    okText: 'Create',
  });
  if (raw === null) return; // cancelled
  addSession(sanitizeName(raw) ?? suggestion, true).intendCreate();
}

// Update only the tab's display label; the tmux session name (s.name) is left
// untouched so closing the tab still kills the original session.
function setDisplayName(s: Session, displayName: string): void {
  s.displayName = displayName;
  if (s.tabLabel) {
    s.tabLabel.textContent = displayName;
    s.tabLabel.title = `session: ${s.name} (double-click to rename)`;
  }
  refreshMobileUI();
}

// Rename a tab (display only). The label can be any text; the underlying tmux
// session keeps its original name, so × still kills the right session.
export async function promptRenameSession(s: Session): Promise<void> {
  const raw = await domPrompt({
    label: `Rename tab (display only — the tmux session stays "${s.name}"):`,
    value: s.displayName,
    okText: 'Rename',
  });
  if (raw === null) return; // cancelled
  const trimmed = raw.trim().slice(0, 64);
  setDisplayName(s, trimmed.length ? trimmed : s.name);
  saveTabs();
  renameOnServer(s.name, s.displayName); // sync the label to other devices
  activeSession?.focus();
}

// Tear down a tab whose session was closed on another device. Unlike
// closeSession this sends NO kill (the session is already gone server-side) —
// it just removes the tab and frees the terminal locally.
export function removeLocalSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  dropTab(s, idx);
  refreshMobileUI();
}

/**
 * Take tab `s` (at `idx`) out of the strip and free both its terminals — what
 * closeSession and removeLocalSession share. If it was open, the tab beside it
 * opens instead.
 *
 * "Open" is judged by the keys as well as by activeTab: should anything ever
 * leave activeSession on this tab's terminals while another tab is open, the
 * key bar, pastes and uploads would go on aiming at a disposed terminal, and
 * the toast would say "reconnecting…" about it for good. Then the tab that is
 * really open is opened again, which points the keys back at it.
 */
function dropTab(s: Session, idx: number): void {
  const held = activeTab === s || activeSession === s || (!!s.mate && activeSession === s.mate);
  sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.dispose(); // its mate too
  if (held) {
    const stillOpen = activeTab !== s ? activeTab : null;
    setActiveTab(null);
    setActiveSession(null);
    const next = stillOpen ?? sessions[idx] ?? sessions[idx - 1] ?? null;
    if (next) activateSession(next);
  }
}

let syncing = false;
// Set once init has built the tabs. Before that the strip is empty because it
// has not been filled yet, not because every tab was closed — a sync landing
// then (the interval, or the page gaining focus while init waits on the
// server) would make a fallback tab, or race init in building the same ones.
let tabsReady = false;

// Reconcile our local tabs with the server's list: adopt sessions opened (or
// renamed) on other devices, drop sessions closed elsewhere. The active tab is
// per-device and never changed here unless its session disappeared.
export async function syncFromServer(): Promise<void> {
  if (syncing || !tabsReady) return;
  syncing = true;
  try {
    const serverTabs = await fetchServerTabs();
    if (!serverTabs) return; // unreachable — keep what we have
    const byName = new Map(serverTabs.map((t) => [t.name, t]));

    // Expire stale guards first so re-opening a name later still works.
    const now = performance.now();
    for (const [name, at] of recentlyClosed) {
      if (now - at > CLOSE_GUARD_MS) recentlyClosed.delete(name);
    }
    for (const [name, at] of recentlyCreated) {
      if (now - at > CREATE_GUARD_MS) recentlyCreated.delete(name);
    }

    // Add tabs opened elsewhere; adopt display-name changes from elsewhere.
    for (const t of serverTabs) {
      if (recentlyClosed.has(t.name)) continue; // don't resurrect a just-closed tab
      // The second session of a split belongs to its tab, not in the strip. The
      // server leaves it out of the list; this is the same rule again, for a
      // server that has not been updated yet. One whose first session is gone
      // is nobody's second half any more, and shows up as an ordinary tab.
      if (isMateName(t.name) && byName.has(primaryNameOf(t.name))) continue;
      const existing = sessions.find((s) => s.name === t.name);
      if (!existing) {
        addSession(t.name, false, t.displayName);
      } else if (t.displayName && t.displayName !== existing.displayName) {
        setDisplayName(existing, t.displayName);
      }
    }

    // Remove tabs closed elsewhere. A tab we built moments ago is exempt: it
    // may not have attached yet, so the server would not list it either.
    let missing = sessions.filter(
      (s) => !byName.has(s.name) && !recentlyCreated.has(s.name) && !recentlyClosed.has(s.name)
    );
    // Absent from the list is not the same as gone. The list is built from a
    // tag the tmux session carries, and a session can lose it while this page
    // is open — a tmux server that dies and comes back through resurrect brings
    // every session back bare. While each tab held its own socket that fixed
    // itself, because attaching is what writes the tag; with tabs attaching
    // only when opened, the next sweep would take every unopened tab instead,
    // five seconds later, with nothing to undo it.
    //
    // So offer the names back before dropping any of them. Only sessions that
    // really exist get adopted, which leaves a tab closed on another device
    // missing from the re-read as well — and it still goes.
    if (missing.length) {
      await readoptTabs(missing.map((s) => ({ name: s.name, displayName: s.displayName })));
      const after = await fetchServerTabs();
      if (!after) return; // unreachable now — keep every tab we have
      const listed = new Set(after.map((t) => t.name));
      missing = missing.filter((s) => !listed.has(s.name));
    }
    for (const s of missing) {
      recentlyClosed.set(s.name, performance.now());
      removeLocalSession(s);
    }

    if (sessions.length === 0) addFallbackTab();
    saveTabs();
  } finally {
    syncing = false;
  }
}

export function setTabsReady(ready: boolean): void {
  tabsReady = ready;
}

// What init (terminal.ts) starts from: the tab the URL asks for and this
// device's cached tab list.
export const urlSession = sanitizeName(params.get('session'));
export const cached = loadTabs(); // per-device cache: offline fallback + last focus
// A sensible value from the first tick (used by closeSession / syncFromServer
// before init resolves); init refines it once the tab list is known.
export let defaultSessionName = urlSession ?? cached.tabs[0]?.name ?? 'web';

export function setDefaultSessionName(name: string): void {
  defaultSessionName = name;
}
