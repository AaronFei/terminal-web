import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
const MIN_DELAY = 500;
const MAX_DELAY = 5000;
const MIN_FONT = 8;
const MAX_FONT = 28;
const KEYBAR_HEIGHT = 48; // px when shown

// Floor on the size we will ever report to the server. xterm's FitAddon happily
// proposes 2x1 whenever the pane momentarily has no layout box (a fullscreen
// switch, a phone's keyboard eating the viewport, a tab being restored), and
// that size goes straight through to tmux, which resizes the window for EVERY
// client attached to that session. A program on the alternate screen (Claude
// Code) has no scrollback, so whatever no longer fits is destroyed rather than
// scrolled off. A session found sitting at 11x6 on this machine is what that
// looks like afterwards. Below this floor we keep the last good size.
const MIN_COLS = 20;
const MIN_ROWS = 5;

// Every tab's tmux window holds two panes — "windows", in the UI's words — and
// this is which of them you are looking at: the first alone, the second alone,
// or both. Showing one is tmux's zoom, so the other keeps running out of sight;
// nothing here closes a pane, only closing the tab does that.
type LayoutMode = 'one' | 'two' | 'both';
// At or above this width both windows go side by side; below it they stack.
// Half of 80 columns is not a terminal anyone can use.
const WIDE_COLS = 100;

// A split tab is still ONE xterm grid — the divider is a column of glyphs in
// it, not a boundary — so xterm's ordinary selection flows straight across it
// and a drag in one window highlights, and copies, the other one's text on the
// same rows. xterm has a second selection mode that stays inside the columns
// you drag, which is exactly what a split needs; these reach it. The value is
// xterm's SelectionMode.COLUMN, a const enum inlined as 3 at build time, so it
// cannot be imported.
const COLUMN_SELECTION_MODE = 3;

interface SelectionInternals {
  _activeSelectionMode: number;
  _model: {
    selectionStart: [number, number] | undefined;
    selectionEnd: [number, number] | undefined;
    selectionStartLength: number;
  };
  shouldColumnSelect(event: MouseEvent | KeyboardEvent): boolean;
  refresh(isLinuxMouseSelection?: boolean): void;
}

// Touch "select" mode (toggled from the key bar). tmux runs with `mouse on`, so
// a finger drag is normally hijacked for scrolling and there is no way to make a
// text selection by touch (on desktop you hold Option to bypass tmux's mouse
// reporting; a tablet has no such key). While this is on, a one-finger drag
// selects text instead of scrolling, and lifting the finger copies it.
let touchSelectMode = false;
// Window to drop a duplicated IME emission. The CapsLock-switch double-send
// arrives ~100-120ms apart (keydown-finalize then compositionend-finalize), so
// 100ms was just too tight; 300ms covers it with margin while staying far below
// the interval of any legitimate re-typing of the same characters.
const IME_DEDUP_MS = 300;

// Cap on the bytes of discrete injections (uploaded file path, paste, key-bar
// press) buffered while the WebSocket is down, so a long outage can't grow the
// queue without bound. 64 KB is far more than any real path/paste.
const MAX_PENDING_SEQ = 64 * 1024;

// macOS uses ⌘ for copy/paste (never a terminal control key), so xterm passes
// it through to the browser. Everything else uses Ctrl, which collides with the
// terminal's ^C/^V — hence the OS-specific copy/paste key handling below.
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

const params = new URLSearchParams(window.location.search);
const IME_DEBUG = (params.get('debug') ?? '').includes('ime');
// ?debug=vv logs visualViewport metrics (keyboard occlusion / Safari pan) to
// the server log via the same WS debug channel, for on-device layout diagnosis.
const VV_DEBUG = (params.get('debug') ?? '').includes('vv');
// ?debug=paste logs what each paste event actually carries (clipboard types,
// item kinds/types, file count) — for diagnosing why image paste-to-upload
// behaves differently across browsers/OSes (e.g. Windows Chrome).
const PASTE_DEBUG = (params.get('debug') ?? '').includes('paste');
// WebGL renderer is on by default; ?webgl=0 (or ?nowebgl) falls back to the DOM
// renderer — useful for flaky GPUs or headless capture.
const WEBGL_ENABLED = params.get('webgl') !== '0' && !params.has('nowebgl');
// ?debug=sel traces touch selection — where a touch landed, whether the long
// press fired, what word it found, what ended up selected — to the server log.
// Selecting is several steps deep and every one of them is invisible when it
// goes wrong on a device you cannot open a console on.
const SEL_DEBUG = (params.get('debug') ?? '').includes('sel');

// Whether this device is touched rather than pointed at.
//
// NOT `(pointer: coarse)`. An iPad browses as a desktop by default — Safari and
// iPadOS Chrome both — and in that mode it answers that query like a mouse, so
// every touch-only affordance here quietly switched itself off on the one
// device that needs them most: no selection handles, the key bar hidden by
// default, and the soft keyboard popping up on every tab switch. maxTouchPoints
// still tells the truth there.
const TOUCH_DEVICE = navigator.maxTouchPoints > 0;

const encoder = new TextEncoder();

/** Sanitize a session name to [A-Za-z0-9_-]{1,64}; null if nothing usable. */
function sanitizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned.length ? cleaned : null;
}

// Copy text to the clipboard. Uses the async Clipboard API on a secure context
// (HTTPS), else falls back to a hidden-textarea + execCommand("copy"), which
// works over plain HTTP within a user gesture.
async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Read the clipboard and send it to the active session. Reading requires a
// secure context (HTTPS); over HTTP we can't, so hint the user to use Cmd/Ctrl-V
// (the native paste event still works when the terminal is focused).
function pasteFromClipboard(): void {
  const clip = navigator.clipboard;
  if (clip && typeof clip.readText === 'function' && window.isSecureContext) {
    clip
      .readText()
      .then((t) => {
        if (t) activeSession?.pasteText(t);
        else openPasteBox();
      })
      .catch(() => openPasteBox());
  } else {
    // Plain HTTP can't read the clipboard via JS, so pop a box the user pastes
    // into (native paste into a real textarea works on HTTP and iPad).
    openPasteBox();
  }
}

// Rich paste for the Windows/Linux Ctrl+Shift+V chord (plain Ctrl+V uses the
// browser's own paste instead): unlike Chrome's built-in "paste as plain text"
// bound to that chord (which drops images) or readText() (text only), the
// async Clipboard API returns BOTH text and image blobs — so a pasted image
// uploads and text goes to the shell. Falls back to the text-only path when the
// Clipboard read API isn't available (non-secure context / older browsers).
async function pasteRich(): Promise<void> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.read === 'function' && window.isSecureContext) {
    try {
      const items = await clip.read();
      let handled = false;
      for (const it of items) {
        const imgType = it.types.find((t) => t.startsWith('image/'));
        if (imgType) {
          const blob = await it.getType(imgType);
          const ext = (imgType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
          void uploadFile(blob, `pasted-image.${ext}`);
          handled = true;
        } else if (it.types.includes('text/plain')) {
          const text = await (await it.getType('text/plain')).text();
          if (text) activeSession?.pasteText(text);
          handled = true;
        }
      }
      if (handled) return;
    } catch {
      /* permission denied / not focused — fall back to the legacy paths */
    }
  }
  pasteFromClipboard();
}

// A small overlay with a real <textarea> the user pastes into, then we forward
// the text to the active session. Works without the Clipboard API (HTTP/iPad).
function openPasteBox(): void {
  if (document.querySelector('.paste-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box';
  const label = document.createElement('div');
  label.className = 'paste-label';
  label.textContent = `Paste here (${isMac ? '⌘V' : 'Ctrl+V'} / long-press → Paste) — sends automatically`;
  const ta = document.createElement('textarea');
  ta.className = 'paste-ta';
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('autocomplete', 'off');
  ta.spellcheck = false;
  const row = document.createElement('div');
  row.className = 'paste-row';
  const cancel = document.createElement('button');
  cancel.className = 'tb-btn';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const send = document.createElement('button');
  send.className = 'tb-btn';
  send.type = 'button';
  send.textContent = 'Send';
  row.append(cancel, send);
  box.append(label, ta, row);
  overlay.append(box);
  document.body.append(overlay);
  window.setTimeout(() => ta.focus(), 0);

  const close = (): void => {
    overlay.remove();
    activeSession?.focus();
  };
  const submit = (): void => {
    const t = ta.value;
    if (t) activeSession?.pasteText(t);
    close();
  };
  send.addEventListener('click', submit);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  // One-tap feel: auto-send right after a paste lands in the box.
  ta.addEventListener('paste', () => window.setTimeout(submit, 0));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

// Quick help overlay: how to copy / paste / attach files. Shown from the "?"
// button and once automatically on first visit.
function openHelp(): void {
  if (document.querySelector('.help-overlay')) return;
  const selKey = isMac ? '⌥ Option' : 'Shift';
  const pasteKey = isMac ? '⌘V' : 'Ctrl+V';
  const copyKey = isMac ? '⌘C' : 'Ctrl+Shift+C';
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay help-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box help-box';
  box.innerHTML =
    '<div class="help-title">How to copy / paste / files</div>' +
    '<ul class="help-list">' +
    `<li><b>Copy</b> — hold <b>${selKey}</b> and drag to select; it copies automatically. (Or select, then <b>${copyKey}</b> / tap <b>Copy</b>.)</li>` +
    `<li><b>Paste</b> — click the terminal, then <b>${pasteKey}</b>${
      isMac ? '' : ' (or Ctrl+Shift+V)'
    }. On a phone/tablet, tap <b>Paste</b> and paste into the box that appears.</li>` +
    (isMac
      ? ''
      : '<li><b>Literal ^V</b> (vim visual-block, readline quoted-insert) — Ctrl+V now pastes, so press <b>Ctrl+Q</b>, which both accept as its alias.</li>') +
    '<li><b>Attach a file</b> (for Claude Code etc.) — tap the 📎 button, or paste / drag any file (image, PDF, text…): it uploads and inserts the file path. Then press Enter.</li>' +
    '<li><b>Download a file</b> — tap the ⬇ button (or <b>⋯ → Download</b> on a phone) and enter a name/relative path from the terminal\'s current folder (e.g. <code>report.zip</code>), or a full path (<code>~/output/report.zip</code>). It downloads to this device.</li>' +
    '<li><b>Scroll</b> — mouse wheel or two-finger swipe scrolls the history.</li>' +
    '<li><b>Tabs</b> — <b>+</b> new session, <b>×</b> closes the tab and kills its session, <b>⟳</b> restarts the session fresh. Double-click (or double-tap) a tab to rename it — the label changes but its tmux session stays the same.</li>' +
    '</ul>' +
    '<div class="paste-row"><button class="tb-btn" type="button" data-help-close>Got it</button></div>';
  overlay.append(box);
  document.body.append(overlay);
  const close = (): void => {
    overlay.remove();
    activeSession?.focus();
  };
  box.querySelector('[data-help-close]')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

const THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const root = document.documentElement;
const topbar = document.getElementById('topbar') as HTMLElement;
const termArea = document.getElementById('terminal') as HTMLElement;
const keybarEl = document.getElementById('keybar') as HTMLElement;
const statusEl = document.getElementById('status');

// Top bar layout: [ tabs (scrollable) ... + ] [ controls ]
const tabsEl = document.createElement('div');
tabsEl.id = 'tabs';
const addBtn = document.createElement('button');
addBtn.className = 'tab-add';
addBtn.type = 'button';
addBtn.textContent = '+';
addBtn.title = 'New session';
tabsEl.append(addBtn);

const controlsEl = document.createElement('div');
controlsEl.id = 'controls';

topbar.append(tabsEl, controlsEl);

let currentFont = (() => {
  try {
    const n = parseInt(localStorage.getItem('tw.fontSize') ?? '', 10);
    if (!Number.isNaN(n)) return Math.min(MAX_FONT, Math.max(MIN_FONT, n));
  } catch {
    /* ignore */
  }
  return 14;
})();

// The size every pane has. All panes are inset:0 in #terminal and share one
// font, so a single measurement taken from the pane on screen is the correct
// size for all of them — including the hidden ones, which are display:none and
// cannot measure themselves. Written by setPaneDims(); 0 until the first fit.
let paneCols = 0;
let paneRows = 0;

function showStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.add('visible');
}
function hideStatus(): void {
  statusEl?.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Session: one terminal + one WebSocket + reconnect, rendered in its own pane.
// ---------------------------------------------------------------------------
class Session {
  // Immutable tmux session id — used for the WebSocket ?session= param and the
  // kill command. Renaming a tab never touches this, so × still kills the
  // original session.
  readonly name: string;
  // Mutable label shown on the tab; defaults to the session name.
  displayName: string;
  readonly term: Terminal;
  readonly el: HTMLElement;
  tabEl: HTMLElement | null = null;
  tabLabel: HTMLElement | null = null;
  tabDot: HTMLElement | null = null;
  connected = false;
  // True once this tab has been looked at and so has attached. Tabs are not
  // connected until then: a page with a dozen of them used to open a dozen
  // WebSockets, spawn a dozen ptys and attach a dozen tmux clients, all for
  // sessions nobody was looking at.
  started = false;

  private readonly fitAddon = new FitAddon();
  private ws: WebSocket | null = null;
  private reconnectDelay = MIN_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // IME double-input guard (order-independent, content-scoped).
  private lastData = '';
  private lastDataAt = 0;

  // The IME's current pre-edit (composing) string, straight from its own
  // compositionupdate events, with the time it was last seen. Nothing in here
  // has been committed, so none of it may reach the pty — only the text the IME
  // hands us at compositionend does, and we send that ourselves. Kept for a
  // moment after the composition ends because xterm's finalize is deferred.
  private composingText = '';
  private composingAt = 0;

  // True between compositionstart and compositionend — i.e. while the soft
  // keyboard is mid-composition (e.g. picking a 注音 candidate). A reconnect
  // that re-fits/re-focuses the terminal during this window cancels the iOS
  // composition (the candidate bar vanishes, input turns raw/direct), so we
  // defer that re-attach work until the composition commits.
  private composing = false;
  private reattachAfterCompose = false;

  // Discrete injections (file path, paste, key-bar seq) buffered while the WS is
  // not OPEN, flushed on the next reconnect (see connect's onopen). Raw typing
  // is never buffered — only these one-shot sends routed through sendSeq().
  private pendingSeq: string[] = [];

  // Which of this tab's two panes is on screen and how many panes the window
  // actually has (1 until the second one is made), both as tmux last reported
  // them — never as what this device last asked for, so a switch made on
  // another device, or in tmux itself, shows up here too.
  layout: LayoutMode = 'one';
  layoutPanes = 1;
  // 0-based column of the divider while both windows are side by side, else
  // null. Selections are clipped to the window they start in using this.
  dividerCol: number | null = null;
  // The split direction we last asked for, so a resize that crosses WIDE_COLS
  // can re-lay the split without overriding one arranged by hand.
  private layoutOrient: 'h' | 'v' | null = null;

  constructor(name: string, displayName?: string) {
    this.name = name;
    this.displayName = displayName?.trim() || name;
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: currentFont,
      scrollback: 100000,
      allowProposedApi: true,
      // Hold Option (macOS) / Shift (others) and drag to select text even while
      // tmux mouse mode is on, so it can be copied.
      macOptionClickForcesSelection: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    this.el = document.createElement('div');
    this.el.className = 'term-pane hidden';
    termArea.append(this.el);
    this.term.open(this.el);

    if (WEBGL_ENABLED) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        this.term.loadAddon(webgl);
      } catch {
        /* fall back to the DOM renderer */
      }
    }

    // Windows/Linux copy-paste. macOS gets this for free: ⌘ is never a terminal
    // key, so xterm ignores ⌘V and the browser's own paste runs — text, images
    // and files all take one path. Ctrl is different: xterm turns Ctrl+V into ^V
    // and Ctrl+C into ^C and cancels the keydown, which ALSO kills the browser's
    // copy/paste and the paste-to-upload event. So on non-Mac we take the keys
    // back:
    //   Ctrl+V        paste. Returning false WITHOUT preventDefault only stops
    //                 xterm making it ^V — the browser then pastes natively, so
    //                 this is the ⌘V path exactly: text, images, files, and it
    //                 still works over plain HTTP where the Clipboard API can't
    //                 read. The cost is ^V (readline quoted-insert, vim
    //                 visual-block), which both accept Ctrl+Q for instead.
    //                 Windows Terminal and VS Code make the same trade.
    //   Ctrl+Shift+V  the same, kept for muscle memory and the Linux-terminal
    //                 convention — but Chrome binds it to "paste as plain text"
    //                 (which drops images), so this chord reads the clipboard
    //                 itself rather than letting the browser do it.
    //   Ctrl+Shift+C  copy the selection (preventDefault so Chrome doesn't open
    //                 DevTools). Plain Ctrl+C stays ^C / SIGINT.
    // Auto-repeat is dropped on both paste chords: holding the key would paste
    // the same block again and again, which at a shell prompt is a duplicated
    // command rather than a typo.
    // This handler ALSO keeps xterm out of IME composition entirely, on every
    // platform — see the compositionend handler in wireInput, which commits the
    // text itself. xterm sends composed text from three places, and starving
    // one is not enough:
    //   1. compositionend        -> _finalizeComposition(true), deferred; reads
    //                               the textarea a tick later (starved there).
    //   2. a non-229 keydown mid-composition -> _finalizeComposition(false),
    //                               SYNCHRONOUS, so blanking the textarea
    //                               afterwards cannot stop it.
    //   3. a 229 keydown while not composing -> _handleAnyTextareaChanges().
    // 2 and 3 both run from _compositionHelper.keydown(), which _keyDown calls
    // only AFTER consulting this handler — so returning false for any keystroke
    // belonging to a composition shuts both off. e.isComposing is per-event, so
    // it cannot latch on if a compositionend is ever missed.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.isComposing || e.keyCode === 229)) {
        return false; // composition keystroke — ours, not xterm's
      }
      if (isMac) return true; // ⌘ needs no remapping; the chords below are Ctrl
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) {
        return true; // not a copy/paste chord — let xterm handle it normally
      }
      // Match the physical key OR the layout's letter, so the chord works on
      // QWERTY and on layouts that move V/C (AZERTY, Dvorak…).
      const isKey = (code: string, ch: string): boolean =>
        e.code === code || (e.key || '').toLowerCase() === ch;
      if (isKey('KeyV', 'v')) {
        if (e.repeat) {
          e.preventDefault(); // a held key must not paste twice
          return false;
        }
        if (!e.shiftKey) return false; // hand it to the browser's native paste
        e.preventDefault(); // Chrome's own Ctrl+Shift+V would drop images
        void pasteRich();
        return false;
      }
      if (e.shiftKey && isKey('KeyC', 'c')) {
        const sel = this.term.getSelection();
        if (sel) void copyText(sel).then((ok) => flashStatus(ok ? 'copied' : 'copy failed', 1200));
        else flashStatus('nothing selected', 1200);
        e.preventDefault(); // block Chrome's Ctrl+Shift+C = open DevTools
        return false; // handled — don't let xterm process it
      }
      return true;
    });

    // Copy the selection to the clipboard when a drag/touch selection ends.
    const copySelection = (): void => {
      const sel = this.term.getSelection();
      if (sel) {
        void copyText(sel).then((ok) => {
          if (ok) flashStatus('copied', 1200);
        });
      }
    };
    // Desktop keeps select-to-copy: the selection is made with a precise
    // pointer and letting go is a deliberate end to it. Touch does not — see
    // the selection bar, which lets an imprecise drag be redone before it
    // decides anything.
    this.el.addEventListener('mousedown', () => {
      this.lastInputWasTouch = false;
    });
    this.el.addEventListener('mouseup', copySelection);

    this.wireInput();
    this.wireTouchScroll();
    this.wireSplitSelection();
    this.wireHandles();
  }

  /**
   * A cell's size and where the grid starts, in CSS pixels. The pane is padded,
   * so its border box is a few pixels wider than the terminal inside it — worth
   * allowing for when the cells themselves are only about eight across.
   */
  private cellSize(): { w: number; h: number; left: number; top: number } {
    const rect = this.el.getBoundingClientRect();
    const style = getComputedStyle(this.el);
    const padX = parseFloat(style.paddingLeft) || 0;
    const padY = parseFloat(style.paddingTop) || 0;
    return {
      w: Math.max(1, rect.width - padX * 2) / Math.max(1, this.term.cols),
      h: Math.max(1, rect.height - padY * 2) / Math.max(1, this.term.rows),
      left: rect.left + padX,
      top: rect.top + padY,
    };
  }

  /**
   * The two drag handles that sit at the ends of a touch selection, the way
   * every native text selection has them. Only ever shown on touch: a pointer
   * can put the selection where it wants first time.
   */
  private wireHandles(): void {
    const make = (which: 'a' | 'b'): HTMLElement => {
      const h = document.createElement('div');
      h.className = `sel-handle sel-${which}`;
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent): void => {
          const cell = this.cellSize();
          const col = Math.max(0, Math.min(this.term.cols - 1, Math.floor((ev.clientX - cell.left) / cell.w)));
          const row = Math.max(0, Math.min(this.term.rows - 1, Math.floor((ev.clientY - cell.top) / cell.h)));
          const at: [number, number] = [col, this.term.buffer.active.viewportY + row];
          if (which === 'a') this.selA = at;
          else this.selB = at;
          this.applySelectionRange();
        };
        const up = (): void => {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      this.el.append(h);
      return h;
    };
    this.handleA = make('a');
    this.handleB = make('b');
  }

  /** Set the selection to the range between two cells and show its handles. */
  setSelectionRange(a: [number, number], b: [number, number]): void {
    this.selA = a;
    this.selB = b;
    this.applySelectionRange();
    if (SEL_DEBUG) {
      this.debugSend(
        'sel-range',
        `a=${a[0]},${a[1]} b=${b[0]},${b[1]} divider=${this.dividerCol} ` +
          `len=${this.term.getSelection().length} has=${this.term.hasSelection() ? 1 : 0}`,
      );
    }
  }

  /** Re-apply the stored range, ordered, and move the handles onto its ends. */
  private applySelectionRange(): void {
    if (!this.selA || !this.selB) return;
    let [sCol, sRow] = this.selA;
    let [eCol, eRow] = this.selB;
    if (eRow < sRow || (eRow === sRow && eCol < sCol)) {
      [sCol, sRow, eCol, eRow] = [eCol, eRow, sCol, sRow];
    }
    if (this.dividerCol !== null) {
      // Split tab: stay inside the window the selection started in.
      const [first, last] = this.windowCols(this.selA[0]);
      const lo = Math.max(first, Math.min(last, Math.min(sCol, eCol)));
      const hi = Math.max(first, Math.min(last, Math.max(sCol, eCol)));
      this.selectBlock(lo, sRow, hi, eRow);
    } else {
      this.useFlowingSelection();
      const length = (eRow - sRow) * this.term.cols + (eCol - sCol) + 1;
      try {
        this.term.select(sCol, sRow, length);
      } catch {
        /* out of range after a redraw — leave the selection as it was */
      }
    }
    this.positionHandles(sCol, sRow, eCol, eRow);
  }

  private positionHandles(sCol: number, sRow: number, eCol: number, eRow: number): void {
    if (!this.handleA || !this.handleB) return;
    // Only for a selection made by touch: a pointer puts one where it wants
    // first time, and two blue circles on a desktop terminal are in the way.
    // Judged by how this selection was made rather than by what the device
    // claims to be, which an iPad in desktop mode gets wrong.
    if (!this.lastInputWasTouch) {
      if (SEL_DEBUG) this.debugSend('sel-handles', 'skipped: last input was not touch');
      return;
    }
    if (SEL_DEBUG) this.debugSend('sel-handles', `at ${sCol},${sRow}-${eCol},${eRow}`);
    const cell = this.cellSize();
    const viewTop = this.term.buffer.active.viewportY;
    const place = (h: HTMLElement, col: number, row: number, below: boolean): void => {
      h.style.left = `${col * cell.w}px`;
      h.style.top = `${(row - viewTop + (below ? 1 : 0)) * cell.h}px`;
      h.classList.add('visible');
    };
    place(this.handleA, sCol, sRow, false);
    place(this.handleB, eCol + 1, eRow, true);
  }

  /** Drop the selection and its handles. */
  clearSelectionRange(): void {
    this.selA = null;
    this.selB = null;
    this.handleA?.classList.remove('visible');
    this.handleB?.classList.remove('visible');
    this.term.clearSelection();
  }

  /** The run of word-ish characters around a cell, as a range. */
  wordRangeAt(col: number, row: number): [[number, number], [number, number]] | null {
    const line = this.term.buffer.active.getLine(row);
    if (!line) return null;
    const text = line.translateToString(false);
    const isWord = (ch: string): boolean => !!ch && !/\s/.test(ch);
    if (!isWord(text[col] ?? '')) return null;
    let a = col;
    let b = col;
    while (a > 0 && isWord(text[a - 1] ?? '')) a -= 1;
    while (b < text.length - 1 && isWord(text[b + 1] ?? '')) b += 1;
    return [
      [a, row],
      [b, row],
    ];
  }

  /**
   * Attach this tab: open its socket, which spawns its pty and its tmux client.
   * Called the first time the tab is shown (see setActive), never before — a
   * tab you have not looked at costs nothing. Idempotent; a reconnect in flight
   * counts as started.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // Adopt the size the panes already have, so the socket opens — and so the
    // pty spawns — at the size this tab is actually going to be.
    if (paneCols && paneRows) this.applyDims(paneCols, paneRows);
    updateTabDot(this);
    this.connect();
  }

  private debug(event: string, data?: string): void {
    if (!IME_DEBUG) return;
    this.debugSend(event, data);
  }

  /** Ungated debug sender — callers gate on their own flag (IME_DEBUG / VV_DEBUG). */
  debugSend(event: string, data?: string): void {
    // eslint-disable-next-line no-console
    console.log('[ime]', this.name, event, JSON.stringify(data ?? ''));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'debug',
          event,
          data: String(data ?? ''),
          at: Math.round(performance.now()),
        }),
      );
    }
  }

  private wireInput(): void {
    const ta = this.term.textarea;
    if (IME_DEBUG && ta) {
      for (const ev of ['compositionstart', 'compositionupdate', 'compositionend']) {
        ta.addEventListener(ev, (e) => this.debug(ev, (e as CompositionEvent).data));
      }
      ta.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing || ke.keyCode === 229 || ke.keyCode === 20) {
          this.debug('keydown', `${ke.key}/${ke.keyCode}`);
        }
      });
    }

    // iOS CJK keyboards send punctuation, numbers and space as a keydown with
    // keyCode 229 and the character in .key, but with NO composition and NO
    // input event — so xterm.js drops them (in Chinese mode those keys did
    // nothing). A real composition key (Bopomofo / pinyin letter) is also
    // keyCode 229 but is followed by compositionstart within a few ms. So on
    // such a keydown we schedule the character, cancel it if a composition
    // starts, and otherwise forward it. English keys (real keyCode) and
    // committed CJK (compositionend → onData) are untouched, so nothing doubles.
    if (ta) {
      // Keep xterm's hidden textarea empty after a paste. xterm reads the text
      // off the event's clipboardData and sends it, but never preventDefaults,
      // so the browser then inserts the same text into that textarea — where it
      // stays until the next Enter / ^C / blur. That matters because xterm
      // tracks IME input as offsets into this textarea: compositionstart takes
      // start = value.length, and the commit sends value.substring(start) — to
      // the END of the value. Compose on top of a stale paste and those offsets
      // are wrong, so part of the old block is committed again: type after
      // pasting and the pasted text reappears. xterm doesn't need the
      // insertion, so cancel it (only when clipboardData actually carried the
      // paste, i.e. xterm has already handled it). Scoped to the terminal's own
      // textarea — the mobile paste box needs its default insertion.
      ta.addEventListener('paste', (e) => {
        if (e.clipboardData) e.preventDefault();
      });

      // Keep it empty after a composition commits, too — this is what actually
      // stops Bopomofo snowballing.
      //
      // The browser inserts the committed text into the textarea AFTER the
      // compositionend dispatch, so clearing from inside that handler is undone
      // a moment later. Windows Bopomofo then pulls the text sitting there
      // straight back into its next composition (the log shows compositionstart
      // immediately followed by a compositionupdate already carrying everything
      // typed before), commits the lot again, and round it goes — each commit
      // longer than the last. compositionend is not cancelable, so the
      // insertion cannot be prevented; the input event that follows it is the
      // first moment the text is really there with no composition active, which
      // makes it the place to clear. Guarded on isComposing so the in-progress
      // composition is never touched.
      ta.addEventListener('input', (e) => {
        if (!(e as InputEvent).isComposing && ta.value !== '') ta.value = '';
      });

      const pendingKeys = new Map<number, string>();
      let lastSeq = -1;
      let seq = 0;
      // Any composition activity means the most-recent IME keydown was actually
      // composition input (Bopomofo / pinyin), so cancel its pending forward.
      // The truly-dropped keys (punctuation / number / space) produce no
      // composition event at all, so their forward survives and fires.
      const cancelLast = (): void => {
        if (lastSeq >= 0) {
          pendingKeys.delete(lastSeq);
          lastSeq = -1;
        }
      };
      ta.addEventListener('compositionstart', () => {
        this.composing = true;
        cancelLast();
        // Never let a composition begin on top of leftover text: that is what
        // the IME reconverts into its own buffer.
        if (ta.value !== '') ta.value = '';
      });
      ta.addEventListener('compositionupdate', (e) => {
        cancelLast();
        if (e.data) {
          this.composingText = e.data;
          this.composingAt = performance.now();
        }
      });
      ta.addEventListener('compositionend', (e) => {
        this.composing = false;
        cancelLast();
        // Commit the composed text ourselves, then empty the textarea.
        //
        // xterm clears this textarea only on Enter / ^C / blur, so while you
        // keep typing it accumulates everything composed so far — and xterm
        // sends a composition by slicing that buffer:
        //   value.substring(_compositionPosition.start + _dataAlreadySent.length)
        // which runs to the END of the value. _compositionPosition.start is
        // refreshed only on compositionstart, and a Windows IME fires that once
        // for a whole run of characters, so start freezes while the buffer
        // grows: every keystroke re-sends a sliding window of everything typed
        // since — type without pressing Enter and the same block floods in over
        // and over. compositionend.data is exactly the committed text, so send
        // that and blank the buffer; xterm's own deferred slice then reads an
        // empty value and sends nothing. Nothing here depends on the IME
        // firing compositionstart per character.
        const text = e.data;
        if (text) {
          // Synchronously, BEFORE the IME opens its next composition: the log
          // shows compositionend and the next compositionstart landing in the
          // same millisecond, so a deferred clear is far too late.
          ta.value = '';
          // If xterm's slice still manages to emit the same text, the onData
          // dedup below drops it.
          this.lastData = text;
          this.lastDataAt = performance.now();
          this.debug('composition-commit', text);
          this.send(text);
        } else {
          // Cancelled composition (Escape): nothing to send, but still reset
          // the buffer — after xterm's deferred slice has run, not racing it.
          window.setTimeout(() => {
            if (!this.composing) ta.value = '';
          }, 0);
        }
        // A reconnect arrived mid-composition and deferred its re-fit/re-focus
        // (see connect's onopen) so it wouldn't cancel the composition; now that
        // we've committed, it's safe to catch up.
        if (this.reattachAfterCompose) {
          this.reattachAfterCompose = false;
          this.resync();
          if (isActive(this)) this.term.focus();
        }
      });
      // The direct-insert half of the IME path. The custom key handler stops
      // xterm seeing 229 keydowns at all, so xterm's own
      // _handleAnyTextareaChanges — which used to deliver these keys — no
      // longer runs, and its _inputEvent fallback bails out whenever a keydown
      // was seen. So this rescue is what carries a key the IME commits with no
      // composition (full-width punctuation, digits, space), and the
      // compositionend handler above carries everything that does compose.
      // Nothing sends twice: a composition cancels the pending forward through
      // cancelLast().
      ta.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.keyCode !== 229) return; // only IME-routed keys
        const k = ke.key;
        if (!k || k.length !== 1) return; // a single printable char (not Enter/Backspace/…)
        const s = ++seq;
        pendingKeys.set(s, k);
        lastSeq = s;
        window.setTimeout(() => {
          if (!pendingKeys.has(s)) return; // a composition consumed it
          pendingKeys.delete(s);
          this.debug('forward-key', k);
          this.send(k);
        }, 90);
      });
    }

    this.term.onData((data: string) => {
      this.debug('onData', data);
      const now = performance.now();
      // Never let the pre-edit string through. Windows Bopomofo keeps ONE
      // composition open while you type — the log shows compositionupdate
      // growing by a character at a time and only flushing a chunk now and
      // then — so at compositionend the textarea still holds uncommitted text.
      // xterm's finalize assumes the opposite (that what is left is exactly
      // what was committed) and fires a few ms later on a setTimeout, sending
      // the remaining pre-edit text: right after our own commit the log shows
      //   composition-commit "喔喔喔喔喔喔ㄟ"
      //   onData             "ㄟㄟㄟㄟㄟㄟ一一一一一一喔喔…"
      // Whatever it sends is a tail of the textarea, hence a tail of the string
      // the IME is composing, which makes this exact rather than a guess. The
      // committed text reaches the pty from the compositionend handler, which
      // calls send() directly and so never passes through here.
      if (
        data &&
        !/[\x00-\x1f]/.test(data) && // never touch control bytes or escapes
        this.composingText.endsWith(data) &&
        now - this.composingAt < 500
      ) {
        this.debug('onData-DROP-preedit', data);
        return;
      }
      // Only dedupe multibyte (IME) content; ASCII/control input is never touched.
      if (
        /[^\x00-\x7F]/.test(data) &&
        data === this.lastData &&
        now - this.lastDataAt < IME_DEDUP_MS
      ) {
        this.lastData = ''; // suppress exactly one duplicate
        this.debug('onData-DROP', data);
        return;
      }
      this.lastData = data;
      this.lastDataAt = now;
      this.send(data);
    });
  }

  private send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encoder.encode(data));
    }
  }

  /**
   * Send a discrete injection (key-bar sequence, paste, uploaded file path).
   * Unlike raw keystrokes, these are buffered and replayed on reconnect when the
   * socket is down — a big upload can saturate the uplink, trip the 20s
   * heartbeat, and land the path insert mid-reconnect, which would otherwise be
   * silently dropped by send() and leave the path un-pasted.
   */
  sendSeq(seq: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(seq);
      return;
    }
    const buffered = this.pendingSeq.reduce((n, s) => n + s.length, 0);
    if (buffered + seq.length <= MAX_PENDING_SEQ) this.pendingSeq.push(seq);
  }

  /**
   * Send clipboard text as a *paste* rather than as typing.
   *
   * A native paste (⌘V, and now Ctrl+V) goes through xterm, which turns
   * newlines into CR and wraps the text in bracketed-paste markers whenever the
   * running program asked for them. Text pushed straight down the socket has
   * neither, so a full-screen TUI (Claude Code, vim, tmux copy-mode) sees a
   * burst of keystrokes instead of one paste: it re-renders per character and
   * takes every LF as Enter, which reprints the line being edited — on screen
   * the block looks pasted twice. So every programmatic paste (the Paste
   * button, the mobile paste box, Ctrl+Shift+V) has to bracket it the same way.
   */
  pasteText(text: string): void {
    if (!text) return;
    const t = text.replace(/\r?\n/g, '\r');
    this.sendSeq(this.term.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t);
  }

  // One-finger touch scrolling. tmux runs in the alternate screen (no
  // xterm-local scrollback) with `mouse on`, so history is browsed via
  // copy-mode, which is normally driven by the mouse wheel. A phone has no
  // wheel, so we translate a one-finger vertical drag into SGR mouse-wheel
  // events sent to tmux — dragging down scrolls back through history, dragging
  // up returns toward the live prompt, just like a real wheel.
  private wireTouchScroll(): void {
    const STEP = 22; // px of drag per wheel "tick"
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let col = 1;
    let row = 1;
    let tracking = false;
    let scrolling = false;

    // Touch-select state (only used while touchSelectMode is on). Anchor is the
    // 0-based cell where the drag started, in absolute buffer coords (so it
    // stays correct even when the view is scrolled into the scrollback).
    let selecting = false;
    let selMoved = false;
    // Long-press picks the word under your finger, so pulling one string out of
    // the screen does not mean arming a mode and then dragging over it exactly.
    let pressTimer: number | null = null;
    let pressFired = false;
    const cancelPress = (): void => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    let anchorCol = 0;
    let anchorRow = 0;
    let cellW = 1;
    let cellH = 1;
    let rectLeft = 0;
    let rectTop = 0;

    // Map a touch point to a 0-based [col, absoluteRow] cell.
    const cellAt = (clientX: number, clientY: number): [number, number] => {
      const c = Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - rectLeft) / cellW)));
      const r = Math.max(0, Math.min(this.term.rows - 1, Math.floor((clientY - rectTop) / cellH)));
      return [c, this.term.buffer.active.viewportY + r];
    };

    this.el.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        // A touch that lands on a selection handle is that handle's to deal
        // with; the terminal must not also start scrolling or a long-press.
        if ((e.target as HTMLElement | null)?.classList?.contains('sel-handle')) {
          tracking = false;
          selecting = false;
          cancelPress();
          return;
        }
        if (e.touches.length !== 1) {
          tracking = false;
          selecting = false;
          cancelPress();
          return;
        }
        cancelPress();
        this.lastInputWasTouch = true;
        const t = e.touches[0];
        startX = t.clientX;
        startY = lastY = t.clientY;
        const cell = this.cellSize();
        cellW = cell.w;
        cellH = cell.h;
        rectLeft = cell.left;
        rectTop = cell.top;
        if (touchSelectMode) {
          // Begin a selection drag; suspend scrolling for this gesture.
          tracking = false;
          selecting = true;
          selMoved = false;
          [anchorCol, anchorRow] = cellAt(t.clientX, t.clientY);
          this.noteTouchColumn(anchorCol);
          this.clearSelectionRange();
          hideSelectionBar();
          return;
        }
        this.noteTouchColumn(cellAt(t.clientX, t.clientY)[0]);
        const pressAt = cellAt(t.clientX, t.clientY);
        if (SEL_DEBUG) {
          this.debugSend(
            'sel-touchstart',
            `cell=${pressAt[0]},${pressAt[1]} mode=${touchSelectMode ? 1 : 0} ` +
              `coarse=${window.matchMedia('(pointer: coarse)').matches ? 1 : 0} ` +
              `touchDevice=${TOUCH_DEVICE ? 1 : 0} maxTouch=${navigator.maxTouchPoints} ` +
              `cols=${this.term.cols} rows=${this.term.rows} target=${(e.target as HTMLElement).className}`,
          );
        }
        pressTimer = window.setTimeout(() => {
          pressTimer = null;
          const range = this.wordRangeAt(pressAt[0], pressAt[1]);
          if (SEL_DEBUG) {
            const line = this.term.buffer.active.getLine(pressAt[1]);
            this.debugSend(
              'sel-press',
              `fired at ${pressAt[0]},${pressAt[1]} range=${range ? JSON.stringify(range) : 'null'} ` +
                `line=${JSON.stringify((line?.translateToString(true) ?? '').slice(0, 60))}`,
            );
          }
          if (!range) return;
          tracking = false;
          pressFired = true;
          this.noteTouchColumn(pressAt[0]);
          this.setSelectionRange(range[0], range[1]);
          showSelectionBar();
        }, 500);
        tracking = true;
        scrolling = false;
        // Cell under the finger, so tmux targets the right pane if it's split.
        col = Math.max(1, Math.min(this.term.cols, Math.floor((t.clientX - rectLeft) / cellW) + 1));
        row = Math.max(1, Math.min(this.term.rows, Math.floor((t.clientY - rectTop) / cellH) + 1));
      },
      { capture: true, passive: true },
    );

    this.el.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (selecting) {
          e.preventDefault();
          e.stopPropagation();
          if (!selMoved && Math.abs(t.clientX - startX) < 6 && Math.abs(t.clientY - startY) < 6) {
            return; // ignore jitter until it's clearly a drag
          }
          selMoved = true;
          if (SEL_DEBUG) this.debugSend('sel-drag', `to ${cellAt(t.clientX, t.clientY).join(',')}`);
          // Ordering, clipping to one window of a split tab, and placing the
          // handles all live in setSelectionRange — the drag just says where
          // the two ends are, exactly as dragging a handle afterwards does.
          this.setSelectionRange([anchorCol, anchorRow], cellAt(t.clientX, t.clientY));
          return;
        }
        if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) cancelPress();
        if (!tracking) return;
        if (!scrolling) {
          const dyTotal = t.clientY - startY;
          const dxTotal = t.clientX - startX;
          // Only hijack once the gesture is clearly a vertical drag, so taps
          // (focus / move cursor) and horizontal gestures still reach xterm.
          if (Math.abs(dyTotal) < 10 || Math.abs(dyTotal) <= Math.abs(dxTotal)) return;
          scrolling = true;
        }
        e.preventDefault();
        e.stopPropagation();
        let dy = t.clientY - lastY;
        let ticks = 0;
        while (Math.abs(dy) >= STEP) {
          if (dy > 0) {
            ticks += 1; // finger down → scroll back (wheel up)
            dy -= STEP;
          } else {
            ticks -= 1; // finger up → toward the live prompt (wheel down)
            dy += STEP;
          }
        }
        lastY = t.clientY - dy; // carry the sub-step remainder
        if (ticks !== 0) this.sendWheel(ticks, col, row);
      },
      { capture: true, passive: false },
    );

    // Copy a finished touch selection. The bubble-phase `copySelection` handler
    // (wired in the constructor) copies term.getSelection() on touchend, so a
    // moved selection lands on the clipboard automatically; a tap with no drag
    // left the selection cleared, so nothing is copied. Select mode stays armed
    // until toggled off again.
    const end = (): void => {
      // A drag that actually selected something leaves the selection up along
      // with its actions, so it can be redone before anything is copied.
      if (selecting && selMoved && this.term.hasSelection()) showSelectionBar();
      cancelPress();
      tracking = false;
      scrolling = false;
      selecting = false;
    };
    // A long-press has already done its job by the time the finger lifts; the
    // tap the browser would synthesise from it would go on to tmux as a click.
    this.el.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!pressFired) return;
        pressFired = false;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true, passive: false },
    );
    this.el.addEventListener('touchend', end, { capture: true, passive: true });
    this.el.addEventListener('touchcancel', end, { capture: true, passive: true });
  }

  // Emit |ticks| SGR mouse-wheel events (Cb 64 = up, 65 = down; press-only).
  private sendWheel(ticks: number, col: number, row: number): void {
    const seq = `\x1b[<${ticks > 0 ? 64 : 65};${col};${row}M`;
    for (let i = Math.abs(ticks); i > 0; i -= 1) this.send(seq);
  }

  private sendResize(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }),
      );
    }
  }

  // Measure the pane and publish the result to every session (setPaneDims).
  // Only the pane on screen can be measured — a hidden one is display:none and
  // has no box — but they are all the same size, so the others take the number
  // from here instead of being left at whatever they started with.
  fit(): void {
    if (this.el.classList.contains('hidden')) return;
    let dims;
    try {
      dims = this.fitAddon.proposeDimensions();
    } catch {
      return; // not laid out yet
    }
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    // A degenerate box (see MIN_COLS) means the layout is mid-flight, not that
    // the terminal is really two columns wide. Keep the last good size.
    if (dims.cols < MIN_COLS || dims.rows < MIN_ROWS) return;
    try {
      this.fitAddon.fit(); // resizes to exactly those dims, clearing the renderer first
    } catch {
      return;
    }
    this.sendResize();
    setPaneDims(this.term.cols, this.term.rows);
  }

  /** Adopt the measured pane size and pass it on to the server. */
  applyDims(cols: number, rows: number): void {
    if (this.term.cols === cols && this.term.rows === rows) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      return;
    }
    this.sendResize();
  }

  /**
   * xterm's selection service. Private API, so everything that uses it checks
   * what it got and falls back to the ordinary selection: an xterm upgrade that
   * moves this should cost the split-tab clipping, not the ability to select.
   */
  private selection(): SelectionInternals | null {
    const core = (this.term as unknown as { _core?: { _selectionService?: unknown } })._core;
    const svc = core?._selectionService as SelectionInternals | undefined;
    if (!svc || typeof svc.refresh !== 'function' || !svc._model) return null;
    return svc;
  }

  /**
   * Make a drag-selection stay inside one window while the tab is split.
   *
   * xterm decides between its two selection modes at mousedown, and refuses the
   * column one on macOS whenever macOptionClickForcesSelection is set — which is
   * how Option-drag makes a selection here at all (tmux's mouse mode owns a
   * plain drag). So the question gets answered here instead: column select
   * whenever the two windows are side by side, xterm's own rule otherwise.
   */
  private wireSplitSelection(): void {
    const svc = this.selection();
    if (!svc || typeof svc.shouldColumnSelect !== 'function') return;
    const xtermsRule = svc.shouldColumnSelect.bind(svc);
    svc.shouldColumnSelect = (event) => this.dividerCol !== null || xtermsRule(event);
  }

  // Column of the last touch or click in this pane, so "select everything" and
  // the split-tab clipping both know which of the two windows you mean.
  private lastTouchCol = 0;

  // The selection as two cells in buffer coordinates, kept so either end can be
  // moved afterwards. A drag on a phone lands where it lands — the finger is
  // over the text it is choosing — so being able to nudge an edge afterwards is
  // most of what makes selecting on a touchscreen bearable.
  // Set by whichever kind of event last landed on this pane. Handles belong to
  // a selection made with a finger, and nothing about the device says that.
  private lastInputWasTouch = false;
  private selA: [number, number] | null = null;
  private selB: [number, number] | null = null;
  private handleA: HTMLElement | null = null;
  private handleB: HTMLElement | null = null;

  /** Note where a gesture landed; the column decides which window it is in. */
  noteTouchColumn(col: number): void {
    this.lastTouchCol = col;
  }

  /**
   * Select everything on screen — clipped to one window when the tab is split,
   * the one last touched. This is the copy most often wanted on a phone, where
   * dragging out an exact range is the hard part.
   */
  selectVisible(): boolean {
    const top = this.term.buffer.active.viewportY;
    const bottom = top + this.term.rows - 1;
    const [first, last] = this.windowCols(this.lastTouchCol);
    this.setSelectionRange([first, top], [last, bottom]);
    return this.term.hasSelection();
  }

  /** First and last column of the window that `col` falls in. */
  private windowCols(col: number): [number, number] {
    const divider = this.dividerCol;
    if (divider === null) return [0, this.term.cols - 1];
    return col < divider ? [0, divider - 1] : [divider + 1, this.term.cols - 1];
  }

  /**
   * Put xterm back in its ordinary flowing selection mode. term.select() sets
   * the selection but not the mode, so without this a flowing drag made after a
   * block one would be read back a column at a time — the right cells
   * highlighted, the wrong text copied.
   */
  private useFlowingSelection(): void {
    const svc = this.selection();
    if (svc) svc._activeSelectionMode = 0; // SelectionMode.NORMAL
  }

  /**
   * Select a block of cells: every row from sRow to eRow, clipped to the
   * columns sCol..eCol. term.select() only makes the flowing kind, and the
   * block kind is otherwise reachable only from an Alt-drag, so the selection
   * model is set here directly. Returns false if xterm's internals have moved,
   * leaving the caller to fall back.
   */
  private selectBlock(sCol: number, sRow: number, eCol: number, eRow: number): boolean {
    const svc = this.selection();
    if (!svc) return false;
    this.term.clearSelection();
    svc._model.selectionStart = [sCol, sRow];
    svc._model.selectionStartLength = 0;
    // The end column is exclusive, and must stay inside the grid.
    svc._model.selectionEnd = [Math.min(this.term.cols, eCol + 1), eRow];
    svc._activeSelectionMode = COLUMN_SELECTION_MODE;
    svc.refresh(true);
    return true;
  }

  /** The split direction this pane's width calls for. */
  private wantOrient(): 'h' | 'v' {
    return this.term.cols >= WIDE_COLS ? 'h' : 'v';
  }

  /**
   * Ask tmux to show one of this tab's windows or both. The second pane is
   * created on demand; showing a single one only zooms it, so neither window
   * is ever closed — the server refuses to do that (see src/tmux.ts).
   */
  setLayout(mode: LayoutMode): void {
    const orient = this.wantOrient();
    this.layoutOrient = orient;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'layout', mode, orient }));
    }
  }

  /** Restack a side-by-side split (or unstack it) once the width changes. */
  relayoutForWidth(): void {
    if (this.layout !== 'both') return;
    if (this.wantOrient() === this.layoutOrient) return;
    this.setLayout('both');
  }

  /** Re-state our size on a freshly opened socket, and re-measure if shown. */
  private resync(): void {
    if (this.el.classList.contains('hidden')) this.sendResize();
    else this.fit(); // re-measures and sends as a side effect
  }

  setFont(px: number): void {
    this.term.options.fontSize = px;
  }

  setActive(active: boolean): void {
    this.el.classList.toggle('hidden', !active);
    if (!active) this.clearSelectionRange(); // a selection belongs to its tab
    if (active) {
      requestAnimationFrame(() => {
        this.fit();
        // Attach now, not at page load: this is the first frame where the pane
        // is laid out, so fit() has the real size to hand the server.
        this.start();
        // On touch (phones / iOS PWA), don't auto-focus the terminal when a
        // session becomes active: focusing xterm's hidden textarea pops up the
        // soft keyboard, so every tab switch forced the keyboard open and the
        // user had to dismiss it each time. Skip the programmatic focus on a
        // coarse pointer — tapping the terminal still focuses it (and raises the
        // keyboard) when the user actually wants to type. Desktop keeps the
        // immediate focus so you can type right after switching.
        if (!TOUCH_DEVICE) this.term.focus();
      });
    }
  }

  focus(): void {
    this.term.focus();
  }

  restart(): void {
    this.term.reset();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'restart' }));
    }
  }

  // Ask the server to kill this tmux session for good (used on tab close).
  // Over HTTP, not this tab's socket: a tab that was never opened has none.
  kill(): void {
    void fetch('/api/sessions/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.name }),
    }).catch(() => {
      /* ignore — the tab is already gone locally */
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }
  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setConnected(state: boolean): void {
    this.connected = state;
    updateTabDot(this);
    if (isActive(this)) reflectActiveStatus();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) return;
    if (isActive(this)) showStatus('reconnecting…');
    const base = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY);
    // Jitter ±50%: when several sessions drop together (e.g. a server restart)
    // this staggers their reconnects instead of firing them all as one burst.
    const delay = Math.round(base * (0.5 + Math.random()));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.disposed) return;
    // Hand the server our size up front so it spawns the pty with it and the
    // tmux client attaches at the size it is going to keep. Attaching at tmux's
    // 80x24 default first — what every connect and reconnect used to do —
    // resizes the window for every other client on that session, and a program
    // on the alternate screen loses everything that no longer fits.
    const url =
      `${wsProto}://${window.location.host}/ws?session=${encodeURIComponent(this.name)}` +
      `&cols=${this.term.cols}&rows=${this.term.rows}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectDelay = MIN_DELAY;
      if (IME_DEBUG) {
        this.debugSend(
          'env',
          `mac=${isMac} coarse=${window.matchMedia('(pointer: coarse)').matches} ` +
            `touch=${TOUCH_DEVICE} maxTouch=${navigator.maxTouchPoints} ` +
            `imeOwned=1 ua=${navigator.userAgent.slice(0, 80)}`,
        );
      }
      this.setConnected(true);
      this.startPing();
      // Flush injections buffered while the socket was down (e.g. an uploaded
      // file path whose insert raced a big-upload reconnect). The socket is
      // OPEN here, so send() delivers them.
      if (this.pendingSeq.length) {
        const buffered = this.pendingSeq;
        this.pendingSeq = [];
        for (const s of buffered) this.send(s);
      }
      // Re-assert a custom label: the server stores it on the tmux session
      // (@twlabel), which is wiped when the session is killed+recreated by a
      // restart, so a renamed tab would otherwise revert to its raw name.
      if (this.displayName !== this.name) renameOnServer(this.name, this.displayName);
      // Re-fit + re-focus so typing resumes smoothly after a reconnect — UNLESS
      // an IME composition is in flight: on iOS these cancel the soft keyboard's
      // active composition, dropping the 注音 candidate bar and turning input
      // raw/direct. Mobile reconnects are frequent, so this otherwise interrupts
      // composing mid-word. Defer to compositionend instead.
      if (this.composing) {
        this.reattachAfterCompose = true;
      } else {
        this.resync();
        if (isActive(this)) this.term.focus();
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as {
            type?: string;
            mode?: LayoutMode;
            panes?: number;
            divider?: number | null;
          };
          // The session was closed (killed) here or on another device: drop the
          // tab and do NOT reconnect — reconnecting would recreate the session
          // via `new-session -A`, resurrecting what was just closed.
          if (msg && msg.type === 'closed') {
            recentlyClosed.set(this.name, performance.now());
            removeLocalSession(this);
          } else if (msg && msg.type === 'layout' && msg.mode) {
            this.layout = msg.mode;
            if (typeof msg.panes === 'number') this.layoutPanes = msg.panes;
            this.dividerCol = typeof msg.divider === 'number' ? msg.divider : null;
            // First word from tmux about this session: take its current split
            // as the one we asked for, so a later resize doesn't re-lay a
            // layout somebody arranged by hand.
            if (this.layoutOrient === null && msg.mode === 'both') {
              this.layoutOrient = this.wantOrient();
            }
            if (isActive(this)) refreshLayoutUI();
          }
        } catch {
          /* ignore */
        }
      }
    };

    socket.onclose = () => {
      this.stopPing();
      if (this.ws === socket) this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------
// Tab / session manager
// ---------------------------------------------------------------------------
const sessions: Session[] = [];
let activeSession: Session | null = null;

function isActive(s: Session): boolean {
  return activeSession === s;
}

function reflectActiveStatus(): void {
  if (!activeSession || activeSession.connected) hideStatus();
  // A tab being opened for the first time is attaching, not reconnecting; its
  // socket opens on the next frame (see setActive).
  else if (!activeSession.started) hideStatus();
  else showStatus('reconnecting…');
}

function updateTabDot(s: Session): void {
  s.tabDot?.classList.toggle('connected', s.connected);
  // A tab nobody has opened yet is not "disconnected" — there is nothing wrong
  // with it, it just hasn't attached. Hollow dot rather than a grey one.
  s.tabDot?.classList.toggle('idle', !s.started);
  refreshMobileUI();
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

  // Single tap activates; a second tap within 350ms renames. Activate on
  // pointerUP (not down) and WITHOUT preventDefault so a sideways drag can scroll
  // the tab strip: a drag that the browser turns into a scroll fires
  // pointercancel, never pointerup, so reaching pointerup means a genuine tap.
  // (The old pointerdown+preventDefault cancelled the pan, making the strip
  // unscrollable once your finger landed on a tab.) touch-action:manipulation on
  // .tab keeps the strip pannable and drops the double-tap-to-zoom.
  let lastTap = 0;
  tab.addEventListener('pointerup', (e) => {
    if (e.target === close) return; // the × has its own handler
    const now = performance.now();
    if (now - lastTap < 350) {
      lastTap = 0;
      promptRenameSession(s);
      return;
    }
    lastTap = now;
    activateSession(s);
  });
  close.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    confirmCloseSession(s);
  });

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

function addSession(name: string, makeActive: boolean, displayName?: string): Session {
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

function activateSession(s: Session): void {
  if (activeSession && activeSession !== s) activeSession.setActive(false);
  activeSession = s;
  s.setActive(true);
  for (const x of sessions) x.tabEl?.classList.toggle('active', x === s);
  // With many tabs the active one can sit off-screen in the horizontal strip
  // (e.g. after picking it from the drawer); scroll it back into view. inline/
  // block: 'nearest' only scrolls #tabs horizontally, never the page/terminal.
  s.tabEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  hideSelectionBar(); // a selection belongs to the tab it was made in
  reflectActiveStatus();
  refreshMobileUI();
  refreshLayoutUI();
  saveTabs();
}

// Ask before killing a session: closing a tab terminates its tmux session and
// any programs running in it, so make the user confirm first.
function confirmCloseSession(s: Session): void {
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

function closeSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  // Guard against a server sync that raced the kill re-adding this tab.
  recentlyClosed.set(s.name, performance.now());
  // Closing a tab kills its tmux session for good (its programs are terminated).
  s.kill();
  sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.dispose();
  if (activeSession === s) {
    activeSession = null;
    const next = sessions[idx] ?? sessions[idx - 1] ?? null;
    if (next) activateSession(next);
  }
  if (sessions.length === 0) addSession(defaultSessionName, true);
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

// PWA-safe replacement for window.prompt(). iOS standalone WebViews (display:
// standalone — see manifest) suppress or hang on the native prompt/alert/confirm
// dialogs, which froze the whole UI when "+ New session" / rename were tapped.
// Render our own overlay instead (same pattern as confirmCloseSession). Resolves
// to the entered text, or null if cancelled/dismissed.
function domPrompt(opts: {
  label: string;
  value?: string;
  okText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    if (document.querySelector('.prompt-overlay')) {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay prompt-overlay';
    const box = document.createElement('div');
    box.className = 'paste-box prompt-box';
    const label = document.createElement('div');
    label.className = 'paste-label';
    label.textContent = opts.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.value = opts.value ?? '';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const row = document.createElement('div');
    row.className = 'paste-row';
    const cancel = document.createElement('button');
    cancel.className = 'tb-btn';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'tb-btn';
    ok.type = 'button';
    ok.textContent = opts.okText ?? 'OK';
    row.append(cancel, ok);
    box.append(label, input, row);
    overlay.append(box);
    document.body.append(overlay);
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    let done = false;
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      overlay.remove();
      activeSession?.focus();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input.value));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
  });
}

async function promptAddSession(): Promise<void> {
  const suggestion = nextSessionName();
  const raw = await domPrompt({
    label: 'New session name:',
    value: suggestion,
    okText: 'Create',
  });
  if (raw === null) return; // cancelled
  addSession(sanitizeName(raw) ?? suggestion, true);
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
async function promptRenameSession(s: Session): Promise<void> {
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

interface SavedTab {
  name: string;
  displayName: string;
}

function saveTabs(): void {
  try {
    localStorage.setItem(
      'tw.tabs',
      JSON.stringify(sessions.map((s) => ({ name: s.name, displayName: s.displayName }))),
    );
    if (activeSession) localStorage.setItem('tw.activeTab', activeSession.name);
  } catch {
    /* ignore */
  }
}

function loadTabs(): { tabs: SavedTab[]; active: string | null } {
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
          tabs.push({ name: item.name, displayName: dn });
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

// Sessions just closed on this device; suppress a racing server sync from
// re-adding them before the kill is reflected server-side. Expired in sync().
const recentlyClosed = new Map<string, number>();
const CLOSE_GUARD_MS = 6000;

// Fetch the server's tab list. Returns null (and we keep local state) if the
// server is unreachable or slow, so a flaky network never blanks the tabs.
async function fetchServerTabs(timeoutMs = 2500): Promise<SavedTab[] | null> {
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

function renameOnServer(name: string, displayName: string): void {
  void fetch('/api/sessions/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName }),
  }).catch(() => {
    /* ignore — local UI already reflects the change */
  });
}

// Tear down a tab whose session was closed on another device. Unlike
// closeSession this sends NO kill (the session is already gone server-side) —
// it just removes the tab and frees the terminal locally.
function removeLocalSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.dispose();
  if (activeSession === s) {
    activeSession = null;
    const next = sessions[idx] ?? sessions[idx - 1] ?? null;
    if (next) activateSession(next);
  }
  refreshMobileUI();
}

let syncing = false;

// Reconcile our local tabs with the server's list: adopt sessions opened (or
// renamed) on other devices, drop sessions closed elsewhere. The active tab is
// per-device and never changed here unless its session disappeared.
async function syncFromServer(): Promise<void> {
  if (syncing) return;
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
      const existing = sessions.find((s) => s.name === t.name);
      if (!existing) {
        addSession(t.name, false, t.displayName);
      } else if (t.displayName && t.displayName !== existing.displayName) {
        setDisplayName(existing, t.displayName);
      }
    }

    // Remove tabs closed elsewhere. A tab we built moments ago is exempt: it
    // may not have attached yet, so the server would not list it either.
    for (const s of sessions.slice()) {
      if (byName.has(s.name)) continue;
      if (recentlyCreated.has(s.name)) continue;
      if (recentlyClosed.has(s.name)) continue;
      removeLocalSession(s);
    }

    if (sessions.length === 0) addSession(defaultSessionName, true);
    saveTabs();
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Layout: key bar height + iOS keyboard offset; fit the active session.
// ---------------------------------------------------------------------------
function fitActive(): void {
  activeSession?.fit();
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
function setPaneDims(cols: number, rows: number): void {
  paneCols = cols;
  paneRows = rows;
  // The pane on screen has already resized itself (fit); the rest follow here.
  if (bgResizeTimer !== null) clearTimeout(bgResizeTimer);
  bgResizeTimer = window.setTimeout(() => {
    bgResizeTimer = null;
    for (const s of sessions) {
      if (!isActive(s)) s.applyDims(paneCols, paneRows);
    }
    // A window that got narrow enough (or wide enough) wants its two panes
    // stacked rather than side by side, or the other way round.
    activeSession?.relayoutForWidth();
  }, BG_RESIZE_DELAY);
}

// Below this width the key bar wraps to several rows (see styles.css) instead
// of being one horizontally-scrollable row, so its height is no longer fixed.
const mobileMQ = window.matchMedia('(max-width: 640px)');

// Publish the key bar's real height into --keybar-h so the terminal sits right
// above it: a fixed value on desktop (single row), the measured wrapped height
// on a phone.
function updateKeybarHeight(): void {
  if (keybarEl.classList.contains('hidden')) {
    root.style.setProperty('--keybar-h', '0px');
  } else {
    const h = mobileMQ.matches ? keybarEl.offsetHeight : KEYBAR_HEIGHT;
    root.style.setProperty('--keybar-h', `${h}px`);
  }
  // The terminal's height is measured from the key bar, and is set in JS now
  // rather than by CSS, so it has to be re-measured whenever the bar changes.
  updateKeyboardOffset();
}

function setKeybarVisible(visible: boolean): void {
  keybarEl.classList.toggle('hidden', !visible);
  keysBtn.classList.toggle('active', visible);
  refreshMobileUI();
  try {
    localStorage.setItem('tw.keybar', visible ? '1' : '0');
  } catch {
    /* ignore */
  }
  requestAnimationFrame(() => {
    updateKeybarHeight();
    fitActive();
  });
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

function cssPx(el: HTMLElement, prop: string): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(prop)) || 0;
}

// The terminal's height with no keyboard up. Everything the keyboard does is
// measured against this, and the terminal keeps it while a keyboard is open so
// the pty is never resized by one — a resize would send tmux a SIGWINCH, and a
// program on the alternate screen has no scrollback to put the lost rows back.
let restingTermH: number | null = null;
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

function updateKeyboardOffset(): void {
  const top = cssPx(termArea, 'top');
  const keybarH = cssPx(root, '--keybar-h');
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
  // stale (rotated mid-type, say) rather than that the keyboard grew.
  const el = document.activeElement;
  const typing = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  if (!typing || restingTermH === null || available > restingTermH) {
    restingTermH = available;
  }
  root.style.setProperty('--term-h', `${Math.round(restingTermH)}px`);

  // What the key bar has to clear to stay above the keyboard. Zero on a browser
  // that shrank the layout viewport for it — the bottom of that viewport is
  // already above the keyboard.
  root.style.setProperty('--kb-gap', `${Math.round(hiddenBelow)}px`);

  const covered = restingTermH - available;
  const room = Math.max(0, restingTermH - KEYBOARD_MIN_VISIBLE_PX);
  const offset = covered > KEYBOARD_MIN_PX ? Math.min(Math.round(covered), room) : 0;
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

// ---------------------------------------------------------------------------
// Top-bar controls + on-screen key bar
// ---------------------------------------------------------------------------
function makeButton(
  parent: HTMLElement,
  cls: string,
  label: string,
  title: string,
  onTap: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  // pointerdown + preventDefault keeps focus on the terminal so the iPad soft
  // keyboard doesn't dismiss; the action runs here for a snappy feel.
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onTap();
  });
  parent.append(b);
  return b;
}

function changeFont(delta: number): void {
  currentFont = Math.min(MAX_FONT, Math.max(MIN_FONT, currentFont + delta));
  try {
    localStorage.setItem('tw.fontSize', String(currentFont));
  } catch {
    /* ignore */
  }
  for (const s of sessions) s.setFont(currentFont);
  fitActive(); // the cell size changed: re-measure and push the new size to all panes
  activeSession?.focus();
}

function toggleFullscreen(): void {
  const d = document as Document & {
    webkitFullscreenElement?: Element;
    webkitExitFullscreen?: () => void;
  };
  const el = root as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (!document.fullscreenElement && !d.webkitFullscreenElement) {
    (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
  } else {
    (document.exitFullscreen ?? d.webkitExitFullscreen)?.call(document);
  }
  setTimeout(() => fitActive(), 100);
}

addBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  promptAddSession();
});

// Sessions list (opens the same bottom-sheet drawer the phone bar uses). On a
// tablet the top #tabs strip turns into a long horizontal scroll that's awkward
// to swipe through once there are many tabs; this gives a one-tap vertical
// picker instead. Hidden on phones (<=640px), which already have a ☰ in
// #mobilebar; shown on tablet/desktop where the drawer CSS is global anyway.
makeButton(controlsEl, 'tb-btn tb-icon', '☰', 'Sessions', () => openDrawer());
const keysBtn = makeButton(controlsEl, 'tb-btn tb-icon', '⌨', 'Toggle on-screen keys', () => {
  setKeybarVisible(keybarEl.classList.contains('hidden'));
  activeSession?.focus();
});
makeButton(controlsEl, 'tb-btn tb-icon', '⟳', 'Restart this session', () => {
  activeSession?.restart();
  activeSession?.focus();
});

// Split view. Each tab's tmux window holds two windows (panes): this picks
// whether you see the first, the second, or both at once. Showing one zooms it
// and leaves the other running out of sight — neither can be closed, only the
// whole tab can. The second pane is made the first time it's needed.
const LAYOUT_BUTTONS: { mode: LayoutMode; label: string; title: string }[] = [
  { mode: 'one', label: '1', title: 'Window 1 only (window 2 keeps running)' },
  { mode: 'two', label: '2', title: 'Window 2 only (window 1 keeps running)' },
  { mode: 'both', label: '⊞', title: 'Show both windows' },
];
const layoutButtons = new Map<LayoutMode, HTMLElement>();
const sheetLayoutButtons = new Map<LayoutMode, HTMLElement>();

function refreshLayoutUI(): void {
  const mode = activeSession?.layout ?? 'one';
  for (const [m, b] of layoutButtons) b.classList.toggle('active', m === mode);
  for (const [m, b] of sheetLayoutButtons) b.classList.toggle('active', m === mode);
}

const layoutSeg = document.createElement('div');
layoutSeg.className = 'tb-seg';
for (const def of LAYOUT_BUTTONS) {
  layoutButtons.set(
    def.mode,
    makeButton(layoutSeg, 'tb-btn', def.label, def.title, () => {
      activeSession?.setLayout(def.mode);
      activeSession?.focus();
    }),
  );
}
controlsEl.append(layoutSeg);

// Reliable file attach for every platform (incl. iPad) and over plain HTTP —
// no clipboard needed: pick any file(s), each uploads and its path is inserted.
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.style.display = 'none';
document.body.append(fileInput);
fileInput.addEventListener('change', () => {
  if (fileInput.files) {
    for (const f of Array.from(fileInput.files)) void uploadFile(f, f.name);
  }
  fileInput.value = '';
});
// The button that opens this picker lives in the ⋯ sheet — on a phone the
// mobile bar has its own 📎 as well, since attaching is what that device is
// mostly used for.

// Pull a file OFF the host back to this device — the reverse of attaching one.
// A tray-with-down-arrow glyph, monochrome like the rest.
const dlBtn = document.createElement('button');
dlBtn.className = 'tb-btn tb-icon';
dlBtn.type = 'button';
dlBtn.title = 'Download a file from the host';
dlBtn.setAttribute('aria-label', 'Download a file from the host');
dlBtn.innerHTML =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
  '<polyline points="7 10 12 15 17 10"></polyline>' +
  '<line x1="12" y1="15" x2="12" y2="3"></line></svg>';
dlBtn.addEventListener('click', () => promptDownload());
controlsEl.append(dlBtn);

makeButton(controlsEl, 'tb-btn tb-icon', '?', 'Help: copy / paste / files', openHelp);
// Everything that isn't reached often — font size, attach, fullscreen, help —
// sits behind this, in the same actions sheet the phone bar opens. The bar
// keeps only what gets used mid-session.
makeButton(controlsEl, 'tb-btn tb-icon', '⋯', 'More actions', () => openSheet());

// --- selection actions (touch) ---------------------------------------------
// Copying used to happen the instant you lifted your finger, so one imprecise
// drag decided everything: overshoot and the whole thing started over, and
// there was never a moment where you could see what you were about to get. The
// selection stays up now and these appear above the key bar.
const selBar = document.createElement('div');
selBar.id = 'selbar';
selBar.className = 'hidden';

function showSelectionBar(): void {
  selBar.classList.remove('hidden');
}
function hideSelectionBar(): void {
  selBar.classList.add('hidden');
}

/** Turn touch-select mode on or off, keeping the key and the bar in step. */
function setTouchSelectMode(on: boolean): void {
  touchSelectMode = on;
  selectBtn?.classList.toggle('armed', on);
  if (!on) {
    activeSession?.clearSelectionRange();
    hideSelectionBar();
  }
}

/** Copy whatever is selected, then leave select mode. */
function copySelectionNow(): void {
  const sel = activeSession?.term.getSelection() ?? '';
  if (!sel) {
    flashStatus('沒有選到東西', 1400);
    return;
  }
  void copyText(sel).then((ok) => flashStatus(ok ? `已複製 ${sel.length} 字` : '複製失敗', 1600));
  setTouchSelectMode(false);
}

function selBarButton(label: string, cls: string, onTap: () => void): void {
  const b = document.createElement('button');
  b.className = `sel-btn ${cls}`;
  b.type = 'button';
  b.textContent = label;
  // A real click, in the gesture: Safari only lets the clipboard be written
  // from one, and a preventDefaulted pointerdown is not it.
  b.addEventListener('click', onTap);
  selBar.append(b);
}

selBarButton('複製', 'primary', () => copySelectionNow());
selBarButton('全選', '', () => {
  if (!activeSession?.selectVisible()) flashStatus('無法全選', 1400);
});
selBarButton('取消', '', () => {
  activeSession?.clearSelectionRange();
  setTouchSelectMode(false);
});
document.body.append(selBar);

// --- on-screen key bar (sends to the active session) -----------------------
interface KeyDef {
  label?: string;
  seq?: string;
  mod?: 'ctrl' | 'alt';
  action?: 'copy' | 'paste' | 'select';
  /** Force a line break here (mobile only): the keys after it wrap to a new row. */
  rowBreak?: boolean;
}
const KEYS: KeyDef[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: '^C', seq: '\x03' },
  { label: 'Enter', seq: '\r' },
  // Touch text-selection toggle: while armed, drag on the terminal to select and
  // lift to copy (a tablet's stand-in for desktop Option-drag selection).
  { label: '選取', action: 'select' },
  // On a phone the arrows get their own second row; everything else stays on the first.
  { rowBreak: true },
  // Ctrl+End: jump to the bottom in Claude Code's fullscreen view (CSI 1;5F).
  { label: '^End', seq: '\x1b[1;5F' },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
];

let ctrlArmed = false;
let altArmed = false;
const modButtons: Partial<Record<'ctrl' | 'alt', HTMLElement>> = {};
let selectBtn: HTMLElement | null = null;

function refreshModVisuals(): void {
  modButtons.ctrl?.classList.toggle('armed', ctrlArmed);
  modButtons.alt?.classList.toggle('armed', altArmed);
}

function applyMods(seq: string): string {
  if (!ctrlArmed && !altArmed) return seq;
  if (/^\x1b\[[ABCD]$/.test(seq)) {
    const mod = 1 + (altArmed ? 2 : 0) + (ctrlArmed ? 4 : 0);
    return `\x1b[1;${mod}${seq[seq.length - 1]}`;
  }
  if (seq.length === 1) {
    let ch = seq;
    if (ctrlArmed) {
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) ch = String.fromCharCode(code & 0x1f);
    }
    if (altArmed) ch = '\x1b' + ch;
    return ch;
  }
  return seq;
}

for (const def of KEYS) {
  if (def.rowBreak) {
    const brk = document.createElement('div');
    brk.className = 'kb-break';
    keybarEl.append(brk);
    continue;
  }
  const b = document.createElement('button');
  b.className = 'kb-key';
  b.type = 'button';
  b.textContent = def.label ?? '';
  b.title = def.label ?? '';
  if (def.mod) modButtons[def.mod] = b;
  if (def.action === 'select') selectBtn = b;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // On touch, never refocus the terminal: focusing its textarea pops up the
    // soft keyboard. The keys send their bytes straight over the WebSocket, so
    // focus isn't needed — preventDefault already keeps whatever focus state
    // (and thus the keyboard) the user already had.
    const refocus = e.pointerType !== 'touch';
    if (def.action === 'select') {
      // Toggle touch-select mode. While on, dragging the terminal selects text
      // (and lifting copies it) instead of scrolling; tap again to go back to
      // scrolling. Never refocus — that would pop the soft keyboard.
      setTouchSelectMode(!touchSelectMode);
      flashStatus(touchSelectMode ? '選取模式:拖曳選字,放開後再按複製' : '選取關閉', 1800);
      return;
    }
    if (def.action === 'copy') {
      const sel = activeSession?.term.getSelection() ?? '';
      if (sel) {
        void copyText(sel).then((ok) => flashStatus(ok ? 'copied' : 'copy failed', 1200));
      } else {
        flashStatus('nothing selected', 1200);
      }
      if (refocus) activeSession?.focus();
      return;
    }
    if (def.action === 'paste') {
      pasteFromClipboard();
      if (refocus) activeSession?.focus();
      return;
    }
    if (def.mod) {
      if (def.mod === 'ctrl') ctrlArmed = !ctrlArmed;
      else altArmed = !altArmed;
      refreshModVisuals();
      return;
    }
    if (def.seq !== undefined) activeSession?.sendSeq(applyMods(def.seq));
    if (ctrlArmed || altArmed) {
      ctrlArmed = false;
      altArmed = false;
      refreshModVisuals();
    }
    if (refocus) activeSession?.focus();
  });
  keybarEl.append(b);
}

// ---------------------------------------------------------------------------
// Mobile UI: a compact top bar + a bottom "Sessions" drawer + an actions
// sheet. Built unconditionally; CSS (@media max-width:640px) hides it on
// desktop and hides the original #topbar on phones. Everything reuses the
// existing session functions, so the two layouts stay in sync.
// ---------------------------------------------------------------------------
const mobilebar = document.createElement('div');
mobilebar.id = 'mobilebar';

function mBtn(label: string, title: string, onTap: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'm-btn';
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onTap();
  });
  return b;
}

const mMenuBtn = mBtn('☰', 'Sessions', () => openDrawer());
const mTitle = document.createElement('button');
mTitle.className = 'm-title';
mTitle.type = 'button';
const mTitleDot = document.createElement('span');
mTitleDot.className = 'tab-dot';
const mTitleLabel = document.createElement('span');
mTitleLabel.className = 'm-title-label';
const mCaret = document.createElement('span');
mCaret.className = 'm-caret';
mCaret.textContent = '▾';
mTitle.append(mTitleDot, mTitleLabel, mCaret);
mTitle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  openDrawer();
});

// Built directly (not via mBtn) so it triggers on a real `click`: iOS refuses to
// open a file picker from a preventDefaulted pointerdown.
const mAttachBtn = document.createElement('button');
mAttachBtn.className = 'm-btn';
mAttachBtn.type = 'button';
mAttachBtn.textContent = '📎';
mAttachBtn.title = 'Attach a file';
mAttachBtn.setAttribute('aria-label', 'Attach a file');
mAttachBtn.addEventListener('click', () => fileInput.click());
const mKeysBtn = mBtn('⌨', 'Toggle on-screen keys', () => {
  // No focus() here: on a phone, focusing the terminal pops the soft keyboard,
  // which defeats the point of toggling the on-screen keys.
  setKeybarVisible(keybarEl.classList.contains('hidden'));
});
const mMoreBtn = mBtn('⋯', 'More actions', () => openSheet());

mobilebar.append(mMenuBtn, mTitle, mAttachBtn, mKeysBtn, mMoreBtn);
document.body.append(mobilebar);

// --- Sessions drawer (bottom sheet) ----------------------------------------
const drawerOverlay = document.createElement('div');
drawerOverlay.className = 'sheet-overlay hidden';
const drawer = document.createElement('div');
drawer.className = 'sheet drawer';
const drawerGrip = document.createElement('div');
drawerGrip.className = 'sheet-grip';
const drawerTitle = document.createElement('div');
drawerTitle.className = 'sheet-title';
drawerTitle.textContent = 'Sessions';
const drawerList = document.createElement('div');
drawerList.className = 'drawer-list';
const drawerNew = document.createElement('button');
drawerNew.className = 'drawer-new';
drawerNew.type = 'button';
drawerNew.textContent = '+  New session';
drawerNew.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  closeDrawer();
  promptAddSession();
});
drawer.append(drawerGrip, drawerTitle, drawerList, drawerNew);
drawerOverlay.append(drawer);
document.body.append(drawerOverlay);
drawerOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === drawerOverlay) closeDrawer();
});

let drawerOpen = false;

function renderDrawer(): void {
  drawerList.textContent = '';
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'drawer-row' + (s === activeSession ? ' active' : '');

    const body = document.createElement('div');
    body.className = 'drawer-body';
    const dot = document.createElement('span');
    dot.className = 'tab-dot' + (s.connected ? ' connected' : '');
    const name = document.createElement('span');
    name.className = 'drawer-name';
    name.textContent = s.displayName;
    body.append(dot, name);
    body.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      activateSession(s);
      closeDrawer();
    });

    const rename = document.createElement('button');
    rename.className = 'drawer-act';
    rename.type = 'button';
    rename.textContent = '✎';
    rename.title = 'Rename tab';
    rename.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptRenameSession(s);
      renderDrawer();
    });

    const close = document.createElement('button');
    close.className = 'drawer-act danger';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close tab & kill session';
    close.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDrawer();
      confirmCloseSession(s);
    });

    row.append(body, rename, close);
    drawerList.append(row);
  }
}

function openDrawer(): void {
  renderDrawer();
  drawerOverlay.classList.remove('hidden');
  drawerOpen = true;
}
function closeDrawer(): void {
  drawerOverlay.classList.add('hidden');
  drawerOpen = false;
  // Don't focus the terminal on touch: this runs inside the tap gesture that
  // picked a session, and a synchronous focus() raises the soft keyboard — so
  // every session switch popped the keyboard. (This, not setActive()'s rAF
  // focus, was the real culprit: focus() outside a user gesture doesn't raise
  // the keyboard on iOS.) The drawer is mobile-only, so skip focus entirely on
  // a coarse pointer; tap the terminal when you actually want to type.
  if (!TOUCH_DEVICE) activeSession?.focus();
}

// --- Actions sheet (font / restart / paste / fullscreen / help) ------------
const sheetOverlay = document.createElement('div');
sheetOverlay.className = 'sheet-overlay hidden';
const sheet = document.createElement('div');
sheet.className = 'sheet actions-sheet';
const sheetGrip = document.createElement('div');
sheetGrip.className = 'sheet-grip';
const sheetTitle = document.createElement('div');
sheetTitle.className = 'sheet-title';
sheetTitle.textContent = 'Actions';

const fontRow = document.createElement('div');
fontRow.className = 'sheet-font';
const fontMinus = document.createElement('button');
fontMinus.className = 'sf-btn';
fontMinus.type = 'button';
fontMinus.textContent = 'A−';
const fontVal = document.createElement('div');
fontVal.className = 'sf-val';
const fontPlus = document.createElement('button');
fontPlus.className = 'sf-btn';
fontPlus.type = 'button';
fontPlus.textContent = 'A+';
function updateFontVal(): void {
  fontVal.textContent = `Font ${currentFont}px`;
}
fontMinus.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  changeFont(-1);
  updateFontVal();
});
fontPlus.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  changeFont(1);
  updateFontVal();
});
fontRow.append(fontMinus, fontVal, fontPlus);

// The same split-view control, at touch size, for the phone's actions sheet
// (the desktop top bar is hidden at that width).
const splitRow = document.createElement('div');
splitRow.className = 'sheet-seg';
const splitLabel = document.createElement('div');
splitLabel.className = 'ss-lbl';
splitLabel.textContent = 'Split view';
splitRow.append(splitLabel);
for (const def of LAYOUT_BUTTONS) {
  const b = document.createElement('button');
  b.className = 'sf-btn';
  b.type = 'button';
  b.textContent = def.label;
  b.title = def.title;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    activeSession?.setLayout(def.mode);
  });
  splitRow.append(b);
  sheetLayoutButtons.set(def.mode, b);
}

function sheetRow(
  ico: string,
  label: string,
  onTap: () => void,
  // Opening a file picker needs a real click: iOS blocks one started from a
  // preventDefaulted pointer event, which is what every other row uses to keep
  // the soft keyboard from dropping.
  useClick = false,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sheet-row';
  b.type = 'button';
  const i = document.createElement('span');
  i.className = 'sheet-ico';
  i.textContent = ico;
  const t = document.createElement('span');
  t.textContent = label;
  b.append(i, t);
  if (useClick) {
    b.addEventListener('click', () => onTap());
  } else {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onTap();
    });
  }
  return b;
}

sheet.append(
  sheetGrip,
  sheetTitle,
  fontRow,
  splitRow,
  sheetRow('⟳', 'Restart this session', () => {
    closeSheet();
    activeSession?.restart();
    activeSession?.focus();
  }),
  sheetRow('📋', 'Paste', () => {
    closeSheet();
    pasteFromClipboard();
  }),
  sheetRow(
    '⧉',
    'Copy the screen',
    () => {
      closeSheet();
      if (activeSession?.selectVisible()) copySelectionNow();
      else flashStatus('無法全選', 1400);
    },
    true,
  ),
  sheetRow(
    '📎',
    'Attach a file',
    () => {
      closeSheet();
      fileInput.click();
    },
    true,
  ),
  sheetRow('⬇', 'Download a file', () => {
    closeSheet();
    promptDownload();
  }),
  sheetRow('⤢', 'Toggle fullscreen', () => {
    closeSheet();
    toggleFullscreen();
  }),
  sheetRow('?', 'Help: copy / paste / files', () => {
    closeSheet();
    openHelp();
  }),
);
sheetOverlay.append(sheet);
document.body.append(sheetOverlay);
sheetOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === sheetOverlay) closeSheet();
});

function openSheet(): void {
  updateFontVal();
  sheetOverlay.classList.remove('hidden');
}
function closeSheet(): void {
  sheetOverlay.classList.add('hidden');
}

// Keep the mobile bar's title + connection dot current, and re-render the open
// drawer when the session list / active tab / connection state changes.
function refreshMobileUI(): void {
  const s = activeSession;
  mTitleLabel.textContent = s ? s.displayName : '—';
  mTitleDot.classList.toggle('connected', !!s?.connected);
  mKeysBtn.classList.toggle('active', !keybarEl.classList.contains('hidden'));
  if (drawerOpen) renderDrawer();
}
refreshMobileUI();

// ---------------------------------------------------------------------------
// Global resize handling
// ---------------------------------------------------------------------------
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
let areaObserver: ResizeObserver | null = null;
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
    updateKeyboardOffset();
  });
  // We may have finished loading after the last one was sent.
  try {
    window.parent.postMessage({ source: 'terminal-web', type: 'viewport-please' }, '*');
  } catch {
    /* a frame we cannot talk back to — nothing to do */
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
  // Read the resting gap now, before anything is focused. Without this the
  // first reading would be taken as the keyboard opened, and a keyboard-sized
  // resting gap means the terminal never moves out from under it.
  updateKeyboardOffset();
  // Once more after layout settles (a PWA's safe areas, Safari's chrome).
  window.setTimeout(updateKeyboardOffset, 1200);
}
window.addEventListener('beforeunload', () => {
  for (const s of sessions) s.dispose();
});

// ---------------------------------------------------------------------------
// File paste / drag-drop / picker -> upload -> insert the saved path into the
// active session, so the program running there (e.g. Claude Code) can read it.
// Any file type works, not just images.
// ---------------------------------------------------------------------------
function flashStatus(text: string, ms: number): void {
  showStatus(text);
  window.setTimeout(() => {
    if (statusEl?.textContent === text) hideStatus();
  }, ms);
}

function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Upload via XMLHttpRequest (not fetch): fetch exposes no upload-progress
// events, so a big file (e.g. 75 MB) just sat on "uploading…" with no feedback.
// xhr.upload.onprogress lets us show a live percentage, and parsing the server's
// JSON {error} surfaces *why* an upload failed (e.g. "file too large") instead
// of a generic message. Never rejects — always resolves so callers can `void` it.
function uploadFile(file: Blob, name?: string): Promise<void> {
  return new Promise((resolve) => {
    if (!file) {
      resolve();
      return;
    }
    // Bind the destination to the tab that's active NOW, at upload start — the
    // file belongs to the terminal you attached it from. onload can fire much
    // later (a big upload, or you switched tabs / backgrounded the app while it
    // ran); using the live activeSession there sent the path to whatever tab
    // happened to be active on completion — the wrong one, or none you were
    // looking at. sendSeq buffers it if that tab's socket is mid-reconnect.
    const target = activeSession;
    const label = name ?? 'file';
    showStatus(`uploading ${label}… 0%`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload' + (name ? `?name=${encodeURIComponent(name)}` : ''));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (e): void => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        showStatus(
          `uploading ${label}… ${pct}% (${fmtMB(e.loaded)}/${fmtMB(e.total)} MB)`,
        );
      } else {
        showStatus(`uploading ${label}… ${fmtMB(e.loaded)} MB`);
      }
    };
    // All bytes are sent; the server is now writing the file and replying.
    xhr.upload.onload = (): void => showStatus(`uploading ${label}… finishing…`);

    xhr.onload = (): void => {
      let data: { path?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        /* non-JSON response */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.path) {
        if (target) {
          // Quote the path if it contains whitespace; append a space so it reads
          // as a complete argument at the prompt.
          const p = /\s/.test(data.path)
            ? `'${data.path.replace(/'/g, `'\\''`)}'`
            : data.path;
          target.sendSeq(p + ' ');
          if (isActive(target)) target.focus();
        }
        // If it landed on a tab you've since switched away from, name it so you
        // know where the path went instead of it seeming to vanish.
        const where = target && !isActive(target) ? ` → ${target.displayName}` : '';
        flashStatus(`file added${where}: ${data.path}`, 2500);
      } else {
        flashStatus(
          data.error ? `upload failed: ${data.error}` : 'file upload failed',
          3500,
        );
      }
      resolve();
    };
    xhr.onerror = (): void => {
      flashStatus('file upload failed', 2500);
      resolve();
    };
    xhr.send(file);
  });
}

// Pull a file off the host back to this device — the reverse of uploadFile. A
// HEAD pre-check turns a bad path into a toast instead of silently saving the
// server's 404 body as a file; the real GET then streams through a transient
// <a download> so large files never buffer in memory. Auth rides on the
// same-origin tw_auth cookie automatically.
async function downloadFromHost(rawPath: string): Promise<void> {
  const p = rawPath.trim();
  if (!p) return;
  // Pass the active session so the server can resolve a relative path against
  // that terminal's current working directory (no absolute path needed).
  const sess = activeSession?.name;
  const url =
    '/api/download?path=' + encodeURIComponent(p) + (sess ? '&session=' + encodeURIComponent(sess) : '');
  showStatus(`preparing ${p}…`);
  let head: Response;
  try {
    head = await fetch(url, { method: 'HEAD' });
  } catch {
    flashStatus('download failed (network)', 2500);
    return;
  }
  if (!head.ok) {
    const why =
      head.status === 404 ? 'not found' : head.status === 400 ? 'bad path' : `error ${head.status}`;
    flashStatus(`download failed: ${why}`, 3000);
    return;
  }
  const size = Number(head.headers.get('content-length') ?? '0');
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = p.split('/').pop() || 'download';
  document.body.append(a);
  a.click();
  a.remove();
  flashStatus(`downloading ${a.download}${size ? ` (${fmtMB(size)} MB)` : ''}…`, 2500);
}

// Ask for a path and download it. A bare filename / relative path resolves
// against the terminal's current directory (server-side), so no absolute path
// is needed — handy on mobile. Shared by the desktop ⬇ button and the mobile
// actions sheet.
function promptDownload(): void {
  void (async () => {
    const p = await domPrompt({
      label: "Download — a filename or relative path (from the terminal's folder), or a full path",
      value: '',
      okText: 'Download',
    });
    if (p) void downloadFromHost(p);
  })();
}

// Capture phase: xterm's own paste handler calls stopPropagation() on its
// textarea/element, so a bubble-phase listener would never see pastes made into
// the focused terminal. Capturing lets us intercept file pastes first. Any file
// kind is uploaded; plain-text pastes fall through to xterm untouched.
window.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (PASTE_DEBUG) {
      const cd = e.clipboardData;
      let kinds = '(no items)';
      if (items) {
        const parts: string[] = [];
        for (let i = 0; i < items.length; i += 1) parts.push(`${items[i].kind}/${items[i].type}`);
        kinds = parts.length ? parts.join(',') : '(empty)';
      }
      const types = cd && cd.types ? Array.from(cd.types).join('|') : '(none)';
      activeSession?.debugSend(
        'paste',
        `types=[${types}] items=[${kinds}] files=${cd?.files?.length ?? 0}`,
      );
    }
    const dt = e.clipboardData;
    if (!dt) return;

    // (1) Real file items — macOS image paste, Win+Shift+S screenshots, any
    // copied file (any type is allowed). (2) Fall back to dt.files, which some
    // browsers populate even when the items list doesn't expose the file.
    const files: File[] = [];
    if (items) {
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].kind === 'file') {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (files.length === 0 && dt.files) {
      for (let i = 0; i < dt.files.length; i += 1) files.push(dt.files[i]);
    }
    if (files.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let xterm also handle it
      for (const f of files) void uploadFile(f, f.name);
      return;
    }

    // (3) Windows-Chrome case: copying an image from a web page (or Office)
    // often delivers it ONLY as text/html (an <img src="data:...">) with NO
    // file item, so the checks above find nothing. Recover the embedded image
    // by parsing the HTML and fetching a data:/blob: src into a Blob. Remote
    // http(s)/file: srcs can't be fetched client-side (CORS/security), so those
    // fall through to xterm's normal text paste.
    const html = dt.getData ? dt.getData('text/html') : '';
    if (html) {
      const src =
        new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') ??
        '';
      if (src.startsWith('data:image/') || src.startsWith('blob:')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void (async () => {
          try {
            const blob = await fetch(src).then((r) => r.blob());
            if (blob.type.startsWith('image/')) {
              const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
              await uploadFile(blob, `pasted-image.${ext}`);
            }
          } catch {
            flashStatus('paste: could not read the image', 2500);
          }
        })();
        return;
      }
      if (PASTE_DEBUG && src) {
        activeSession?.debugSend('paste', `unfetchable img src=${src.slice(0, 48)}`);
      }
    }
    // Nothing uploadable: let xterm handle the (text) paste.
  },
  true,
);

function dragHasFile(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.items.length; i += 1) {
    if (dt.items[i].kind === 'file') return true;
  }
  return false;
}

termArea.addEventListener('dragover', (e) => {
  if (!dragHasFile(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  termArea.classList.add('dragging');
});
termArea.addEventListener('dragleave', () => termArea.classList.remove('dragging'));
termArea.addEventListener('drop', (e) => {
  termArea.classList.remove('dragging');
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  e.preventDefault();
  for (const f of Array.from(files)) void uploadFile(f, f.name);
});

// ---------------------------------------------------------------------------
// Init: restore tabs (or start one), restore prefs, activate.
// ---------------------------------------------------------------------------
const urlSession = sanitizeName(params.get('session'));
const cached = loadTabs(); // per-device cache: offline fallback + last focus
// A sensible value from the first tick (used by closeSession / syncFromServer
// before init resolves); init refines it once the tab list is known.
let defaultSessionName = urlSession ?? cached.tabs[0]?.name ?? 'web';

async function init(): Promise<void> {
  // The server's list is authoritative; fall back to the local cache, then to
  // a single default session when both are empty.
  let server = await fetchServerTabs();
  // Any tab this device remembers that the server does not list: hand over the
  // names and let it re-adopt the ones whose sessions really exist. That is
  // what a tmux-resurrect restore leaves behind — resurrect brings the sessions
  // back but not their @twtab option, and with tabs only attaching when opened,
  // nothing else would ever re-tag them. It happens for a partial restore too,
  // where the server lists the sessions that survived and none of the rest, so
  // this is not conditional on the list being empty.
  const listed = new Set((server ?? []).map((t) => t.name));
  const unlisted = cached.tabs.filter((t) => !listed.has(t.name)).map((t) => t.name);
  if (unlisted.length) {
    await adoptOnServer(unlisted);
    server = await fetchServerTabs();
  }
  let initialTabs: SavedTab[] =
    server && server.length
      ? server
      : cached.tabs.length
        ? cached.tabs.slice()
        : [{ name: defaultSessionName, displayName: defaultSessionName }];
  if (urlSession && !initialTabs.some((t) => t.name === urlSession)) {
    initialTabs = [{ name: urlSession, displayName: urlSession }, ...initialTabs];
  }
  defaultSessionName = urlSession ?? initialTabs[0]?.name ?? 'web';

  // Build every tab (creation order is tab order). None of them attaches here:
  // activating one is what opens its socket, on the frame after its pane has
  // been laid out and measured — so a tab attaches at the size it will really
  // have, and a tab nobody opens costs nothing at all.
  for (const t of initialTabs) addSession(t.name, false, t.displayName);

  const activeName = urlSession ?? cached.active ?? initialTabs[0].name;
  activateSession(sessions.find((s) => s.name === activeName) ?? sessions[0]);
}

void init();

// Keep the tab list in sync with the server: when the page regains focus /
// visibility, and on a light interval while visible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncFromServer();
});
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
