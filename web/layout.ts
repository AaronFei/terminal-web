// Where the terminals go: pane size, the split, the key bar height and the
// soft keyboard slide.

import { KEYBAR_HEIGHT, TOUCH_DEVICE, VV_DEBUG, WIDE_PX } from './config.js';
import type { LayoutMode } from './config.js';
import { keybarEl, root, termArea } from './dom.js';
import { activeSession, activeTab, isActive, sessions, setActiveSession } from './state.js';
import { reflectActiveStatus } from './status.js';
import type { Session } from './session.js';

// The size every pane has. All panes are inset:0 in #terminal and share one
// font, so a single measurement taken from the pane on screen is the correct
// size for all of them — including the hidden ones, which are display:none and
// cannot measure themselves. Written by setPaneDims(); 0 until the first fit.
export let paneCols = 0;
export let paneRows = 0;

/** Point typing and the key bar at one of the open tab's terminals. */
export function focusPane(s: Session): void {
  if (!isActive(s) || activeSession === s) return;
  setActiveSession(s);
  markFocusedPane();
  reflectActiveStatus();
}

/** Say which half has the keys, but only while there are two to tell apart. */
function markFocusedPane(): void {
  const split = activeTab?.view === 'both';
  for (const s of [activeTab, activeTab?.mate]) {
    s?.el.classList.toggle('focused', split && s === activeSession);
  }
  // The other half's prompt may sit somewhere else entirely; slide for it.
  if (keyboardUp) scheduleKeyboardOffset();
}

// Whether the split last laid out went one above the other. Only read while a
// tab on 'both' is open, and that tab was laid out when it was opened.
let splitStacked = false;

/**
 * Put a tab's terminals on screen: one of them, the other, or both — side by
 * side when there is room for two usable ones, stacked when there is not.
 *
 * The two are placed by hand rather than by a flex container because they are
 * absolutely positioned siblings of every other tab's pane, all of them filling
 * #terminal. The gap between them is the whole of the divider: there is no
 * character anywhere in either grid that has to be kept straight.
 */
export function layOutTab(tab: Session): void {
  const mate = tab.view === 'one' ? tab.mate : tab.ensureMate();
  const both = tab.view === 'both' && !!mate;
  const vertical = both && termArea.clientWidth < WIDE_PX;
  if (both) splitStacked = vertical; // what restackSplit watches for a change

  tab.half = both;
  if (mate) mate.half = both;

  if (both && mate) {
    // A 2px gap, showing the background between them.
    tab.el.style.inset = vertical ? '0 0 calc(50% + 1px) 0' : '0 calc(50% + 1px) 0 0';
    mate.el.style.inset = vertical ? 'calc(50% + 1px) 0 0 0' : '0 0 0 calc(50% + 1px)';
  } else {
    tab.el.style.inset = '';
    if (mate) mate.el.style.inset = '';
  }
  tab.el.classList.toggle('split', both);
  mate?.el.classList.toggle('split', both);

  const showFirst = tab.view !== 'two';
  const showSecond = tab.view !== 'one' && !!mate;
  tab.setShown(showFirst);
  mate?.setShown(showSecond);

  // Keys follow what is on screen: the terminal that had them if it is still
  // up, else whichever one is. Being on the open tab is not enough — going from
  // both halves to the second one alone leaves the first one's grid hidden, and
  // typing into a hidden terminal is typing into nothing you can see.
  const onScreen = [showFirst ? tab : null, showSecond ? mate : null].filter(
    (s): s is Session => !!s,
  );
  if (!activeSession || !onScreen.includes(activeSession)) {
    setActiveSession(onScreen[0] ?? tab);
  }
  markFocusedPane();
  reflectActiveStatus();
}

// ---------------------------------------------------------------------------
// Layout: key bar height + iOS keyboard offset; fit the active session.
// ---------------------------------------------------------------------------
export function fitActive(): void {
  restackSplit();
  // Both halves of a split, not just the one with the keys: the keyboard coming
  // up takes rows from each of them.
  activeTab?.fit();
  if (activeTab?.view !== 'one') activeTab?.mate?.fit();
}

/**
 * Lay the split on screen out again when the window has crossed WIDE_PX —
 * rotating a tablet, dragging a window narrower — so its halves go from side by
 * side to stacked or back. Nothing else would: the halves of a split never
 * publish a size (see fit), so setPaneDims never runs while one is up. Only on
 * a change of answer, because layOutTab re-shows both panes and re-fits them.
 */
function restackSplit(): void {
  if (activeTab?.view !== 'both') return;
  if (termArea.clientWidth < WIDE_PX !== splitStacked) layOutTab(activeTab);
}

// Resizing a tmux window makes it reflow its whole history, so the panes nobody
// is looking at wait for the drag to settle rather than following every frame.
const BG_RESIZE_DELAY = 250;
let bgResizeTimer: number | null = null;

// Publish the size measured from the pane on screen to every session. The
// hidden ones cannot measure themselves, and leaving them at the size they
// happened to start with is what left every tab you weren't looking at attached
// to tmux at 80x24 — one reconnect of such a client and tmux resized the window
// to 80x24 for everyone on it, taking the alternate screen's contents with it.
export function setPaneDims(cols: number, rows: number): void {
  paneCols = cols;
  paneRows = rows;
  // The pane on screen has already resized itself (fit); the rest follow here.
  if (bgResizeTimer !== null) clearTimeout(bgResizeTimer);
  bgResizeTimer = window.setTimeout(() => {
    bgResizeTimer = null;
    // Each hidden terminal takes the size it will have when its tab is next
    // shown, so showing it costs no resize. That is the full pane for a tab on
    // 'one', and on 'two' for its second half too, which is then what fills
    // the pane. A tab on 'both' is left alone, both halves of it: they open at
    // half the pane, at the size they last measured themselves, and handing
    // them the full one here would send each a SIGWINCH now and another on
    // the way back. (The first half of a tab on 'two' is not shown at all; it
    // keeps following the full pane, the size 'one' would give it.)
    for (const s of sessions) {
      if (s.view === 'both') continue;
      if (!isActive(s)) s.applyDims(paneCols, paneRows);
      if (s.view === 'two' && s.mate && !isActive(s.mate)) s.mate.applyDims(paneCols, paneRows);
    }
  }, BG_RESIZE_DELAY);
}

// Below this width the key bar wraps to several rows (see styles.css) instead
// of being one horizontally-scrollable row, so its height is no longer fixed.
const mobileMQ = window.matchMedia('(max-width: 640px)');

// Publish the key bar's real height into --keybar-h so the terminal sits right
// above it: a fixed value on desktop (single row), the measured wrapped height
// on a phone.
export function updateKeybarHeight(): void {
  if (keybarEl.classList.contains('hidden')) {
    root.style.setProperty('--keybar-h', '0px');
  } else {
    const h = mobileMQ.matches ? keybarEl.offsetHeight : KEYBAR_HEIGHT;
    root.style.setProperty('--keybar-h', `${h}px`);
  }
  // The terminal's height is measured from the key bar, and is set in JS now
  // rather than by CSS, so it has to be re-measured whenever the bar changes.
  // Everything that calls this (a resize, the bar toggled, the mobile
  // breakpoint, fullscreen) can also move the terminal's top, so both cached
  // lengths go.
  forgetTermGeometry();
  updateKeyboardOffset();
}

export function isKeybarVisible(): boolean {
  return !keybarEl.classList.contains('hidden');
}

// Where the bottom of what you can actually see sits, in the coordinate space
// our fixed elements live in (the layout viewport). Browsers split two ways
// over a soft keyboard: iOS Safari leaves the layout viewport alone and shrinks
// only the visual one, while Chrome on iPadOS shrinks the layout viewport
// itself. Measuring the visible bottom covers both without asking which is
// which — the first reports a smaller visual viewport, the second a smaller
// innerHeight, and this number drops either way.
function visibleBottom(): number {
  const vv = window.visualViewport;
  if (!vv) return window.innerHeight;
  return Math.min(window.innerHeight, vv.offsetTop + vv.height);
}

export function cssPx(el: HTMLElement, prop: string): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(prop)) || 0;
}

// The terminal's top and the key bar's height, as updateKeyboardOffset last
// read them. It runs on every frame the terminal draws while the keyboard is
// up, and each read is a getComputedStyle, so they are kept until something
// that really moves them: a resize or rotation, the key bar shown, hidden or
// re-wrapped, fullscreen (see updateKeybarHeight), or a change of width.
let termTopPx: number | null = null;
let keybarPx: number | null = null;
function forgetTermGeometry(): void {
  termTopPx = null;
  keybarPx = null;
}

// The terminal's height with no keyboard up. Everything the keyboard does is
// measured against this, and the terminal keeps it while a keyboard is open so
// the pty is never resized by one — a resize would send tmux a SIGWINCH, and a
// program on the alternate screen has no scrollback to put the lost rows back.
let restingTermH: number | null = null;
// The window width restingTermH was taken at. A soft keyboard never changes
// the width; a rotation or a real resize does, and then the old resting height
// is meaningless and is taken again.
let restingWidth: number | null = null;
// Below this, treat it as noise rather than a keyboard. Low enough to catch an
// iPad's shortcut bar (~45-55px) when a hardware keyboard is attached, which
// covers the prompt just as effectively as a full keyboard does.
const KEYBOARD_MIN_PX = 40;
// Never slide so far that there is nothing left to read.
const KEYBOARD_MIN_VISIBLE_PX = 72;

// How much of us the keyboard covers according to the page that frames us. A
// frame's own visualViewport does not track the top-level one, so when embedded
// (entry's launcher) none of the measurements above notice a keyboard at all —
// only the framing page can see it, and it says so by postMessage.
let framedCovered = 0;

export let keyboardUp = false;
// The slide in use, and the terminal it was worked out for. While the keyboard
// stays up it only grows: Claude Code draws lines below its prompt and takes
// them away again as you type, and following each one would bounce the whole
// terminal up and down under your fingers. It starts over when the keyboard
// goes away or the keys move to another terminal.
let slidePx = 0;
let slideFor: Session | null = null;
let kbOffsetFrame = 0;
export function scheduleKeyboardOffset(): void {
  if (kbOffsetFrame) return;
  kbOffsetFrame = requestAnimationFrame(() => {
    kbOffsetFrame = 0;
    updateKeyboardOffset();
  });
}

function updateKeyboardOffset(): void {
  const width = window.innerWidth;
  const resized = width !== restingWidth;
  if (resized) forgetTermGeometry(); // a rotation moves the safe areas too
  if (termTopPx === null) termTopPx = cssPx(termArea, 'top');
  if (keybarPx === null) keybarPx = cssPx(root, '--keybar-h');
  const top = termTopPx;
  const keybarH = keybarPx;
  // Everything hidden below what can be seen, however we came to know about it:
  // a shrunken visual viewport, a shrunken layout viewport, or a framing page
  // telling us. Only one of the three is ever non-zero.
  const hiddenBelow = Math.max(
    0,
    window.innerHeight - visibleBottom(),
    framedCovered,
  );
  const available = Math.max(0, window.innerHeight - hiddenBelow - keybarH - top);

  // A soft keyboard is only up while something is focused, so with nothing
  // focused this IS the resting height. While typing, take any increase: the
  // keyboard can only ever cost room, so more room means the resting value was
  // stale rather than that the keyboard grew.
  //
  // Only a touch device has a soft keyboard. On a desktop xterm's textarea is
  // focused the whole time, so holding the height there meant it could only
  // ever grow: a shorter window (or DevTools docked below) cut off the bottom
  // rows, or was taken for a keyboard and slid the terminal up.
  //
  // And on any device a new width is a rotation or a real resize — the
  // keyboard never changes it — so the resting height is taken again, even
  // mid-type. Rotating with the keyboard up then sizes the terminal to what is
  // left above the keyboard until it goes away, rather than keeping the old
  // orientation's height and running off the bottom of the screen.
  const el = document.activeElement;
  const typing =
    TOUCH_DEVICE && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement);
  if (!typing || resized || restingTermH === null || available > restingTermH) {
    restingTermH = available;
    restingWidth = width;
  }
  root.style.setProperty('--term-h', `${Math.round(restingTermH)}px`);

  // What the key bar has to clear to stay above the keyboard. Zero on a browser
  // that shrank the layout viewport for it — the bottom of that viewport is
  // already above the keyboard.
  root.style.setProperty('--kb-gap', `${Math.round(hiddenBelow)}px`);

  const covered = restingTermH - available;
  const room = Math.max(0, restingTermH - KEYBOARD_MIN_VISIBLE_PX);
  const maxOffset = covered > KEYBOARD_MIN_PX ? Math.min(Math.round(covered), room) : 0;
  keyboardUp = maxOffset > 0;
  if (!keyboardUp || activeSession !== slideFor) slidePx = 0; // see slidePx
  slideFor = activeSession;
  let offset = 0;
  if (keyboardUp) {
    const needed = activeSession
      ? Math.ceil(activeSession.contentBottomPx() - available)
      : maxOffset;
    // Never past maxOffset, though: a keyboard that got shorter (its
    // suggestion strip gone) leaves less to clear, not more.
    offset = Math.max(0, Math.min(maxOffset, Math.max(slidePx, needed)));
  }
  slidePx = offset;
  root.style.setProperty('--kb-offset', `${offset}px`);

  if (VV_DEBUG) {
    const vv = window.visualViewport;
    activeSession?.debugSend(
      'vv',
      `ih=${window.innerHeight} vvh=${Math.round(vv?.height ?? 0)} ` +
        `vvTop=${Math.round(vv?.offsetTop ?? 0)} hidden=${Math.round(hiddenBelow)} ` +
        `framed=${framedCovered} top=${Math.round(top)} keybar=${Math.round(keybarH)} ` +
        `avail=${Math.round(available)} resting=${Math.round(restingTermH)} ` +
        `covered=${Math.round(covered)} off=${offset} typing=${typing ? 1 : 0}`,
    );
  }
  // Deliberately no fit() here: the keyboard slides the terminal, it never
  // resizes it. A change to --term-h is a real size change and reaches fit()
  // through the ResizeObserver on #terminal.
}

// Split view. A tab can show a second terminal beside its own: this picks
// whether you see the first, the second, or both at once. Both keep running
// whichever you are looking at — only closing the tab closes them. The second
// session is made the first time it is asked for.
export const LAYOUT_BUTTONS: { mode: LayoutMode; label: string; title: string }[] = [
  { mode: 'one', label: '1', title: 'First terminal only (the second keeps running)' },
  { mode: 'two', label: '2', title: 'Second terminal only (the first keeps running)' },
  { mode: 'both', label: '⊞', title: 'Show both terminals' },
];
export const layoutButtons = new Map<LayoutMode, HTMLElement>();
export const sheetLayoutButtons = new Map<LayoutMode, HTMLElement>();

export function refreshLayoutUI(): void {
  const mode = activeTab?.view ?? 'one';
  for (const [m, b] of layoutButtons) b.classList.toggle('active', m === mode);
  for (const [m, b] of sheetLayoutButtons) b.classList.toggle('active', m === mode);
}

// ---------------------------------------------------------------------------
// Global resize handling
// ---------------------------------------------------------------------------
let areaObserver: ResizeObserver | null = null;

export function initResizeHandling(): void {
  window.addEventListener('resize', () => {
    updateKeybarHeight(); // rows may re-wrap when the width changes
    fitActive();
  });
  // Re-measure when crossing the mobile breakpoint (e.g. rotating the phone),
  // since the key bar switches between a fixed row and the wrapped layout.
  mobileMQ.addEventListener('change', () => {
    updateKeybarHeight();
    fitActive();
  });
  if (typeof ResizeObserver !== 'undefined') {
    areaObserver = new ResizeObserver(() => fitActive());
    areaObserver.observe(termArea);
  }
  // Embedded: the framing page is the only one that can see the keyboard, so it
  // tells us. Nothing else here can, and a wrong guess is worse than none.
  if (window.parent !== window) {
    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { source?: unknown; type?: unknown; covered?: unknown } | null;
      if (!d || d.source !== 'entry' || d.type !== 'viewport') return;
      const n = typeof d.covered === 'number' && Number.isFinite(d.covered) ? d.covered : 0;
      const covered = Math.max(0, Math.min(2000, Math.round(n)));
      if (covered === framedCovered) return;
      framedCovered = covered;
      // Once a frame at most, like the visualViewport listeners below.
      scheduleKeyboardOffset();
    });
    // We may have finished loading after the last one was sent.
    try {
      window.parent.postMessage({ source: 'terminal-web', type: 'viewport-please' }, '*');
    } catch {
      /* a frame we cannot talk back to — nothing to do */
    }
  }

  if (window.visualViewport) {
    // Once a frame at most: a keyboard sliding up fires these in bursts, and the
    // terminal drawing schedules the same update (see onRender).
    window.visualViewport.addEventListener('resize', scheduleKeyboardOffset);
    window.visualViewport.addEventListener('scroll', scheduleKeyboardOffset);
    // Read the resting gap now, before anything is focused. Without this the
    // first reading would be taken as the keyboard opened, and a keyboard-sized
    // resting gap means the terminal never moves out from under it.
    updateKeyboardOffset();
    // Once more after layout settles (a PWA's safe areas, Safari's chrome) —
    // which can move the terminal's top, so that is read again too.
    window.setTimeout(() => {
      forgetTermGeometry();
      updateKeyboardOffset();
    }, 1200);
  }
  // Fullscreen takes the browser's chrome away and the safe areas with it, and
  // can be left with Esc rather than our button: re-measure either way.
  document.addEventListener('fullscreenchange', updateKeybarHeight);
  document.addEventListener('webkitfullscreenchange', updateKeybarHeight);
  // Nothing is torn down on unload. The browser closes the sockets itself, and a
  // page put in the back/forward cache comes back whole: its sockets are closed
  // or dead by then, which the reconnect and wakeOnScreen's pageshow check pick
  // up. Disposing every session here used to bring that page back with no
  // terminals in it.
}
