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
// Window to drop a duplicated IME emission. The CapsLock-switch double-send
// arrives ~100-120ms apart (keydown-finalize then compositionend-finalize), so
// 100ms was just too tight; 300ms covers it with margin while staying far below
// the interval of any legitimate re-typing of the same characters.
const IME_DEDUP_MS = 300;

const params = new URLSearchParams(window.location.search);
const IME_DEBUG = (params.get('debug') ?? '').includes('ime');

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
        if (t) activeSession?.sendSeq(t);
        else openPasteBox();
      })
      .catch(() => openPasteBox());
  } else {
    // Plain HTTP can't read the clipboard via JS, so pop a box the user pastes
    // into (native paste into a real textarea works on HTTP and iPad).
    openPasteBox();
  }
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
  label.textContent = 'Paste here (⌘V / long-press → Paste) — sends automatically';
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
    if (t) activeSession?.sendSeq(t);
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
  readonly name: string;
  readonly term: Terminal;
  readonly el: HTMLElement;
  tabEl: HTMLElement | null = null;
  tabDot: HTMLElement | null = null;
  connected = false;

  private readonly fitAddon = new FitAddon();
  private ws: WebSocket | null = null;
  private reconnectDelay = MIN_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // IME double-input guard (order-independent, content-scoped).
  private lastData = '';
  private lastDataAt = 0;

  constructor(name: string) {
    this.name = name;
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

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      /* fall back to canvas/DOM renderer */
    }

    // Copy the selection to the clipboard when a drag/touch selection ends.
    const copySelection = (): void => {
      const sel = this.term.getSelection();
      if (sel) {
        void copyText(sel).then((ok) => {
          if (ok) flashStatus('copied', 1200);
        });
      }
    };
    this.el.addEventListener('mouseup', copySelection);
    this.el.addEventListener('touchend', copySelection);

    this.wireInput();
    this.connect();
  }

  private debug(event: string, data?: string): void {
    if (!IME_DEBUG) return;
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

    this.term.onData((data: string) => {
      this.debug('onData', data);
      const now = performance.now();
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

  /** Send a raw key sequence (used by the on-screen key bar for the active session). */
  sendSeq(seq: string): void {
    this.send(seq);
  }

  private sendResize(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }),
      );
    }
  }

  fit(): void {
    if (this.el.classList.contains('hidden')) return; // don't fit a hidden pane
    try {
      this.fitAddon.fit();
    } catch {
      /* not laid out yet */
    }
    this.sendResize();
  }

  setFont(px: number): void {
    this.term.options.fontSize = px;
    this.fit();
  }

  setActive(active: boolean): void {
    this.el.classList.toggle('hidden', !active);
    if (active) {
      requestAnimationFrame(() => {
        this.fit();
        this.term.focus();
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
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.disposed) return;
    const url = `${wsProto}://${window.location.host}/ws?session=${encodeURIComponent(this.name)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectDelay = MIN_DELAY;
      this.setConnected(true);
      this.fit();
      this.startPing();
      if (isActive(this)) this.term.focus();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data === 'string') {
        try {
          JSON.parse(ev.data);
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
  if (activeSession && activeSession.connected) hideStatus();
  else showStatus('reconnecting…');
}

function updateTabDot(s: Session): void {
  s.tabDot?.classList.toggle('connected', s.connected);
}

function buildTab(s: Session): void {
  const tab = document.createElement('div');
  tab.className = 'tab';
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = s.name;
  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = 'Close tab';
  tab.append(dot, label, close);

  tab.addEventListener('pointerdown', (e) => {
    if (e.target === close) return;
    e.preventDefault();
    activateSession(s);
  });
  close.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeSession(s);
  });

  s.tabEl = tab;
  s.tabDot = dot;
  tabsEl.insertBefore(tab, addBtn); // keep the "+" button last
  updateTabDot(s);
}

function addSession(name: string, makeActive: boolean): Session {
  let s = sessions.find((x) => x.name === name);
  if (!s) {
    s = new Session(name);
    sessions.push(s);
    buildTab(s);
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
  reflectActiveStatus();
  saveTabs();
}

function closeSession(s: Session): void {
  const idx = sessions.indexOf(s);
  if (idx < 0) return;
  // Closing a tab only detaches: the tmux session keeps running server-side and
  // resumes if you reopen the same name. (Use ⟳ Restart to discard a session.)
  sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.dispose();
  if (activeSession === s) {
    activeSession = null;
    const next = sessions[idx] ?? sessions[idx - 1] ?? null;
    if (next) activateSession(next);
  }
  if (sessions.length === 0) addSession(defaultSessionName, true);
  saveTabs();
}

function nextSessionName(): string {
  const used = new Set(sessions.map((s) => s.name));
  for (const c of ['web', 'work', 'dev', 'scratch']) if (!used.has(c)) return c;
  let i = 2;
  while (used.has(`s${i}`)) i += 1;
  return `s${i}`;
}

function promptAddSession(): void {
  const suggestion = nextSessionName();
  const raw = window.prompt('New session name:', suggestion);
  if (raw === null) return; // cancelled
  addSession(sanitizeName(raw) ?? suggestion, true);
}

function saveTabs(): void {
  try {
    localStorage.setItem('tw.tabs', JSON.stringify(sessions.map((s) => s.name)));
    if (activeSession) localStorage.setItem('tw.activeTab', activeSession.name);
  } catch {
    /* ignore */
  }
}

function loadTabs(): { names: string[]; active: string | null } {
  try {
    const parsed = JSON.parse(localStorage.getItem('tw.tabs') ?? '[]');
    const active = localStorage.getItem('tw.activeTab');
    if (Array.isArray(parsed)) {
      const names = parsed.filter((x): x is string => typeof x === 'string');
      return { names, active };
    }
  } catch {
    /* ignore */
  }
  return { names: [], active: null };
}

// ---------------------------------------------------------------------------
// Layout: key bar height + iOS keyboard offset; fit the active session.
// ---------------------------------------------------------------------------
function fitActive(): void {
  activeSession?.fit();
}

function setKeybarVisible(visible: boolean): void {
  keybarEl.classList.toggle('hidden', !visible);
  root.style.setProperty('--keybar-h', visible ? `${KEYBAR_HEIGHT}px` : '0px');
  keysBtn.classList.toggle('active', visible);
  try {
    localStorage.setItem('tw.keybar', visible ? '1' : '0');
  } catch {
    /* ignore */
  }
  requestAnimationFrame(() => fitActive());
}

function updateKeyboardOffset(): void {
  const vv = window.visualViewport;
  const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  root.style.setProperty('--kb-offset', `${offset}px`);
  fitActive();
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

makeButton(controlsEl, 'tb-btn', 'A−', 'Smaller font', () => changeFont(-1));
makeButton(controlsEl, 'tb-btn', 'A+', 'Larger font', () => changeFont(1));
const keysBtn = makeButton(controlsEl, 'tb-btn tb-icon', '⌨', 'Toggle on-screen keys', () => {
  setKeybarVisible(keybarEl.classList.contains('hidden'));
  activeSession?.focus();
});
makeButton(controlsEl, 'tb-btn tb-icon', '⟳', 'Restart this session', () => {
  activeSession?.restart();
  activeSession?.focus();
});

// Reliable image attach for every platform (incl. iPad) and over plain HTTP —
// no clipboard needed: pick/take a photo, it uploads and the path is inserted.
const imageInput = document.createElement('input');
imageInput.type = 'file';
imageInput.accept = 'image/*';
imageInput.multiple = true;
imageInput.style.display = 'none';
document.body.append(imageInput);
imageInput.addEventListener('change', () => {
  if (imageInput.files) {
    for (const f of Array.from(imageInput.files)) void uploadImage(f, f.name);
  }
  imageInput.value = '';
});
makeButton(controlsEl, 'tb-btn tb-icon', '🖼', 'Attach an image (upload + insert path)', () => {
  imageInput.click();
});

makeButton(controlsEl, 'tb-btn tb-icon', '⤢', 'Toggle fullscreen', toggleFullscreen);

// --- on-screen key bar (sends to the active session) -----------------------
interface KeyDef {
  label: string;
  seq?: string;
  mod?: 'ctrl' | 'alt';
  action?: 'copy' | 'paste';
}
const KEYS: KeyDef[] = [
  { label: 'Copy', action: 'copy' },
  { label: 'Paste', action: 'paste' },
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End', seq: '\x1b[F' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: '^C', seq: '\x03' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
];

let ctrlArmed = false;
let altArmed = false;
const modButtons: Partial<Record<'ctrl' | 'alt', HTMLElement>> = {};

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
  const b = document.createElement('button');
  b.className = 'kb-key';
  b.type = 'button';
  b.textContent = def.label;
  b.title = def.label;
  if (def.mod) modButtons[def.mod] = b;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (def.action === 'copy') {
      const sel = activeSession?.term.getSelection() ?? '';
      if (sel) {
        void copyText(sel).then((ok) => flashStatus(ok ? 'copied' : 'copy failed', 1200));
      } else {
        flashStatus('nothing selected', 1200);
      }
      activeSession?.focus();
      return;
    }
    if (def.action === 'paste') {
      pasteFromClipboard();
      activeSession?.focus();
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
    activeSession?.focus();
  });
  keybarEl.append(b);
}

// ---------------------------------------------------------------------------
// Global resize handling
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => fitActive());
let areaObserver: ResizeObserver | null = null;
if (typeof ResizeObserver !== 'undefined') {
  areaObserver = new ResizeObserver(() => fitActive());
  areaObserver.observe(termArea);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
}
window.addEventListener('beforeunload', () => {
  for (const s of sessions) s.dispose();
});

// ---------------------------------------------------------------------------
// Image paste / drag-drop -> upload -> insert the saved path into the active
// session, so the program running there (e.g. Claude Code) can read the image.
// ---------------------------------------------------------------------------
function flashStatus(text: string, ms: number): void {
  showStatus(text);
  window.setTimeout(() => {
    if (statusEl?.textContent === text) hideStatus();
  }, ms);
}

async function uploadImage(file: Blob, name?: string): Promise<void> {
  if (!file || !file.type.startsWith('image/')) return;
  showStatus('uploading image…');
  try {
    const res = await fetch(
      '/upload' + (name ? `?name=${encodeURIComponent(name)}` : ''),
      { method: 'POST', headers: { 'Content-Type': file.type }, body: file },
    );
    if (!res.ok) {
      flashStatus('image upload failed', 2500);
      return;
    }
    const data = (await res.json()) as { path?: string };
    if (data.path && activeSession) {
      // Quote the path if it contains whitespace; append a space so it reads as
      // a complete argument at the prompt.
      const p = /\s/.test(data.path)
        ? `'${data.path.replace(/'/g, `'\\''`)}'`
        : data.path;
      activeSession.sendSeq(p + ' ');
      activeSession.focus();
    }
    flashStatus(`image added: ${data.path ?? ''}`, 2500);
  } catch {
    flashStatus('image upload failed', 2500);
  }
}

// Capture phase: xterm's own paste handler calls stopPropagation() on its
// textarea/element, so a bubble-phase listener would never see pastes made into
// the focused terminal. Capturing lets us intercept image pastes first.
window.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          e.stopImmediatePropagation(); // don't let xterm also handle it
          void uploadImage(f, f.name);
        }
        return;
      }
    }
    // No image item: leave the event alone so xterm handles a normal text paste.
  },
  true,
);

function dragHasImage(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.items.length; i += 1) {
    if (dt.items[i].type.startsWith('image/')) return true;
  }
  return false;
}

termArea.addEventListener('dragover', (e) => {
  if (!dragHasImage(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  termArea.classList.add('dragging');
});
termArea.addEventListener('dragleave', () => termArea.classList.remove('dragging'));
termArea.addEventListener('drop', (e) => {
  termArea.classList.remove('dragging');
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (imgs.length === 0) return;
  e.preventDefault();
  for (const f of imgs) void uploadImage(f, f.name);
});

// ---------------------------------------------------------------------------
// Init: restore tabs (or start one), restore prefs, activate.
// ---------------------------------------------------------------------------
const urlSession = sanitizeName(params.get('session'));
const restored = loadTabs();
const defaultSessionName = urlSession ?? restored.names[0] ?? 'web';

let initialNames = restored.names.length ? restored.names.slice() : [defaultSessionName];
if (urlSession && !initialNames.includes(urlSession)) initialNames = [urlSession, ...initialNames];

for (const name of initialNames) addSession(name, false);

const activeName = urlSession ?? restored.active ?? initialNames[0];
activateSession(sessions.find((s) => s.name === activeName) ?? sessions[0]);

// Default: show the key bar on touch devices, hidden on desktop (unless saved).
const keybarDefault = (() => {
  try {
    const v = localStorage.getItem('tw.keybar');
    if (v !== null) return v === '1';
  } catch {
    /* ignore */
  }
  return window.matchMedia('(pointer: coarse)').matches;
})();
setKeybarVisible(keybarDefault);
