// Constants, URL flags and small pure helpers shared by every module.

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
export const MIN_DELAY = 500;
export const MAX_DELAY = 5000;
// Heartbeat (see Session.startPing): a ping every PING_MS; a socket that lets
// one go unanswered for PING_TIMEOUT_MS — nothing at all arriving — is taken
// for dead. Right after the page wakes the bar is WAKE_PING_MS, since that is
// when a dead one is most likely and the user is waiting on it. A tick running
// PING_LATE_MS past its time means the page was frozen, not the socket.
export const PING_MS = 20_000;
export const PING_TIMEOUT_MS = 2 * PING_MS;
export const WAKE_PING_MS = 5_000;
export const PING_LATE_MS = 10_000;
export const MIN_FONT = 8;
export const MAX_FONT = 28;
export const KEYBAR_HEIGHT = 48; // px when shown

// Floor on the size we will ever report to the server. xterm's FitAddon happily
// proposes 2x1 whenever the pane momentarily has no layout box (a fullscreen
// switch, a phone's keyboard eating the viewport, a tab being restored), and
// that size goes straight through to tmux, which resizes the window for EVERY
// client attached to that session. A program on the alternate screen (Claude
// Code) has no scrollback, so whatever no longer fits is destroyed rather than
// scrolled off. A session found sitting at 11x6 on this machine is what that
// looks like afterwards. Below this floor we keep the last good size.
export const MIN_COLS = 20;
export const MIN_ROWS = 5;

// A tab can show two terminals: its own session, and a second one beside it.
// This is which you are looking at — the first alone, the second alone, or both
// at once. Neither is ever closed by switching; closing the tab closes both.
export type LayoutMode = 'one' | 'two' | 'both';
// Below this pane width the two go one above the other rather than side by
// side. Half of 80 columns is not a terminal anyone can use.
export const WIDE_PX = 760;

// The second terminal is a SESSION OF ITS OWN, named after the first.
//
// It used to be tmux's own split: one window, two panes, drawn into one xterm
// grid with the divider as a column of glyphs inside it. That divider was
// content, and tmux only ever sends differences — so once the browser's grid
// and tmux's model of it disagreed, the border stayed drawn a column or two off
// on a few rows for as long as the page was open. Everything downstream had to
// know where that column was: selections had to be clipped to one side of it,
// which took a block-selection mode reachable only through xterm's private
// selection service, and every resize had to force a full repaint.
//
// Two sessions side by side have no divider to get wrong. Each gets its own
// pty at its own size, its own selection, and its own clipboard, and the gap
// between them is a CSS gap. What tmux is asked for is an attach and nothing
// else.
//
// The pairing is in the NAME rather than a tmux option, because options are
// what a tmux-resurrect restore drops — the same way it drops @twtab — and a
// name survives it. `work` has `work__b`; nothing else needs storing.
const MATE_SUFFIX = '__b';
// The server takes session names of up to 64 characters and refuses longer
// ones rather than cutting them short. A tab's second half is its name plus
// the suffix, so a tab's own name has to leave room for it: one at the full 64
// would get a split whose second session can never attach.
const MAX_TAB_NAME = 64 - MATE_SUFFIX.length;

/** The name of the second session beside `name`. */
export function mateNameOf(name: string): string {
  return name + MATE_SUFFIX;
}

/** Whether `name` is the second session of some pair. */
export function isMateName(name: string): boolean {
  return name.endsWith(MATE_SUFFIX);
}

/** The first session of the pair `name` is the second of. */
export function primaryNameOf(name: string): string {
  return name.slice(0, -MATE_SUFFIX.length);
}

// Window to drop a duplicated IME emission. The CapsLock-switch double-send
// arrives ~100-120ms apart (keydown-finalize then compositionend-finalize), so
// 100ms was just too tight; 300ms covers it with margin while staying far below
// the interval of any legitimate re-typing of the same characters.
export const IME_DEDUP_MS = 300;

// Cap on the bytes of discrete injections (uploaded file path, paste)
// buffered while the WebSocket is down, so a long outage can't grow the
// queue without bound. 64 KB is far more than any real path/paste.
export const MAX_PENDING_SEQ = 64 * 1024;

// macOS uses ⌘ for copy/paste (never a terminal control key), so xterm passes
// it through to the browser. Everything else uses Ctrl, which collides with the
// terminal's ^C/^V — hence the OS-specific copy/paste key handling below.
export const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

export const params = new URLSearchParams(window.location.search);
export const IME_DEBUG = (params.get('debug') ?? '').includes('ime');
// ?debug=vv logs visualViewport metrics (keyboard occlusion / Safari pan) to
// the server log via the same WS debug channel, for on-device layout diagnosis.
export const VV_DEBUG = (params.get('debug') ?? '').includes('vv');
// ?debug=paste logs what each paste event actually carries (clipboard types,
// item kinds/types, file count) — for diagnosing why image paste-to-upload
// behaves differently across browsers/OSes (e.g. Windows Chrome).
export const PASTE_DEBUG = (params.get('debug') ?? '').includes('paste');
// WebGL renderer is on by default; ?webgl=0 (or ?nowebgl) falls back to the DOM
// renderer — useful for flaky GPUs or headless capture.
export const WEBGL_ENABLED = params.get('webgl') !== '0' && !params.has('nowebgl');
// ?debug=sel traces touch selection — where a touch landed, whether the long
// press fired, what word it found, what ended up selected — to the server log.
// Selecting is several steps deep and every one of them is invisible when it
// goes wrong on a device you cannot open a console on.
export const SEL_DEBUG = (params.get('debug') ?? '').includes('sel');

// Whether this device is touched rather than pointed at.
//
// maxTouchPoints rather than `(pointer: coarse)`: it is a count of digitizers,
// not a judgement about the primary input, so it does not move when a tablet
// decides to present itself as a desktop. (The iPad here answers coarse=1
// maxTouch=5 — see ?debug=sel — so the missing selection handles it was blamed
// for were really a stale stylesheet; the query is just the shakier question to
// be asking.)
export const TOUCH_DEVICE = navigator.maxTouchPoints > 0;

export const encoder = new TextEncoder();

/**
 * Sanitize a tab's session name to [A-Za-z0-9_-]{1,61} (see MAX_TAB_NAME);
 * null if nothing usable.
 */
export function sanitizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_TAB_NAME);
  return cleaned.length ? cleaned : null;
}

export const THEME = {
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

export const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
