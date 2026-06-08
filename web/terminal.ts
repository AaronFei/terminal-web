import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

// ---------------------------------------------------------------------------
// Session selection from URL: ?session=NAME (default "web"), sanitized to
// match the server's expectation: [A-Za-z0-9_-]{1,64}, fallback "web".
// ---------------------------------------------------------------------------
function resolveSession(): string {
  const raw = new URLSearchParams(window.location.search).get('session') ?? 'web';
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '');
  if (cleaned.length >= 1 && cleaned.length <= 64) return cleaned;
  return 'web';
}

const SESSION = resolveSession();

// ---------------------------------------------------------------------------
// Terminal setup
// ---------------------------------------------------------------------------
const term = new Terminal({
  cursorBlink: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 14,
  scrollback: 100000,
  allowProposedApi: true,
  theme: {
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
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());

const container = document.getElementById('terminal') as HTMLElement;
term.open(container);

// WebGL renderer is best-effort; ignore failures (e.g. no GPU/context).
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => {
    webgl.dispose();
  });
  term.loadAddon(webgl);
} catch {
  // ignore: fall back to the canvas/DOM renderer.
}

const statusEl = document.getElementById('status');

function showStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.add('visible');
}

function hideStatus(): void {
  if (!statusEl) return;
  statusEl.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// WebSocket connection with capped exponential backoff reconnect.
// ---------------------------------------------------------------------------
const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${wsProto}://${window.location.host}/ws?session=${encodeURIComponent(SESSION)}`;

let ws: WebSocket | null = null;
let reconnectDelay = 500; // ms, grows up to MAX_DELAY
const MIN_DELAY = 500;
const MAX_DELAY = 5000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let closed = false;

function sendResize(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }),
    );
  }
}

function fit(): void {
  try {
    fitAddon.fit();
  } catch {
    // container may not be laid out yet; ignore.
  }
  sendResize();
}

function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20000);
}

function stopPing(): void {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect(): void {
  if (closed) return;
  if (reconnectTimer !== null) return;
  showStatus('reconnecting…');
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (closed) return;

  const socket = new WebSocket(WS_URL);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    reconnectDelay = MIN_DELAY;
    hideStatus();
    setConnected(true);
    // Send an initial resize right after open so the pty matches our viewport.
    // Do NOT term.reset() here: tmux repaints and we want to preserve scrollback.
    fit();
    startPing();
    term.focus();
  };

  socket.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(ev.data));
      return;
    }
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === 'pong') {
          // heartbeat acknowledged; nothing to do.
        }
        // {type:"info"} and others are silently ignored for now.
      } catch {
        // ignore malformed control frames.
      }
    }
  };

  socket.onclose = () => {
    stopPing();
    if (ws === socket) ws = null;
    setConnected(false);
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will follow and trigger reconnect; close proactively.
    try {
      socket.close();
    } catch {
      // ignore.
    }
  };
}

// User input -> server (raw bytes, UTF-8 encoded).
const encoder = new TextEncoder();
term.onData((data: string) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encoder.encode(data));
  }
});

// ---------------------------------------------------------------------------
// Resize handling: window resize + ResizeObserver + initial fit on load.
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => fit());

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => fit());
  ro.observe(container);
}

window.addEventListener('beforeunload', () => {
  closed = true;
  stopPing();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore.
    }
  }
});

// ---------------------------------------------------------------------------
// UI: top control bar + bottom virtual key bar (arrows & terminal keys).
// ---------------------------------------------------------------------------
const root = document.documentElement;

// Send a raw key sequence to the pty (same path as term.onData).
function sendSeq(seq: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encoder.encode(seq));
  }
}

// Connection indicator (green dot) in the top bar.
let statusDot: HTMLElement | null = null;
function setConnected(connected: boolean): void {
  if (statusDot) statusDot.classList.toggle('connected', connected);
}

const topbar = document.getElementById('topbar') as HTMLElement;
const keybarEl = document.getElementById('keybar') as HTMLElement;
const KEYBAR_HEIGHT = 48; // px, must visually contain .kb-key buttons

// --- top bar: status + buttons --------------------------------------------
const statusWrap = document.createElement('div');
statusWrap.className = 'tb-status';
statusDot = document.createElement('span');
statusDot.className = 'dot';
const sessionLabel = document.createElement('span');
sessionLabel.className = 'tb-session';
sessionLabel.textContent = SESSION;
statusWrap.append(statusDot, sessionLabel);

const spacer = document.createElement('div');
spacer.className = 'spacer';

// pointerdown + preventDefault keeps focus on the terminal so the iPad soft
// keyboard does not dismiss; the action runs on pointerdown for a snappy feel.
function makeButton(
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
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onTap();
  });
  return b;
}

const MIN_FONT = 8;
const MAX_FONT = 28;
function changeFont(delta: number): void {
  const cur = term.options.fontSize ?? 14;
  const next = Math.min(MAX_FONT, Math.max(MIN_FONT, cur + delta));
  term.options.fontSize = next;
  try {
    localStorage.setItem('tw.fontSize', String(next));
  } catch {
    /* ignore */
  }
  fit();
  term.focus();
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
  setTimeout(() => fit(), 100);
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
  requestAnimationFrame(() => fit());
}

const fontDecBtn = makeButton('tb-btn', 'A−', 'Smaller font', () => changeFont(-1));
const fontIncBtn = makeButton('tb-btn', 'A+', 'Larger font', () => changeFont(1));
const keysBtn = makeButton('tb-btn', '⌨ Keys', 'Toggle on-screen keys', () => {
  setKeybarVisible(keybarEl.classList.contains('hidden'));
  term.focus();
});
const fsBtn = makeButton('tb-btn', '⤢', 'Toggle fullscreen', toggleFullscreen);

topbar.append(statusWrap, spacer, fontDecBtn, fontIncBtn, keysBtn, fsBtn);

// --- bottom key bar: data-driven keys with sticky Ctrl/Alt -----------------
interface KeyDef {
  label: string;
  seq?: string;
  mod?: 'ctrl' | 'alt';
}

const KEYS: KeyDef[] = [
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

// Fold any armed Ctrl/Alt into the outgoing sequence.
function applyMods(seq: string): string {
  if (!ctrlArmed && !altArmed) return seq;
  const isArrow = /^\x1b\[[ABCD]$/.test(seq);
  if (isArrow) {
    // xterm modifier param: 1 + (shift?1) + (alt?2) + (ctrl?4)
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
  // Multi-char non-arrow keys (Home/End/PgUp/PgDn) are sent unmodified.
  return seq;
}

function makeKey(def: KeyDef): HTMLElement {
  const b = document.createElement('button');
  b.className = 'kb-key';
  b.type = 'button';
  b.textContent = def.label;
  b.title = def.label;
  if (def.mod) modButtons[def.mod] = b;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (def.mod) {
      if (def.mod === 'ctrl') ctrlArmed = !ctrlArmed;
      else altArmed = !altArmed;
      refreshModVisuals();
      return;
    }
    if (def.seq !== undefined) sendSeq(applyMods(def.seq));
    if (ctrlArmed || altArmed) {
      ctrlArmed = false;
      altArmed = false;
      refreshModVisuals();
    }
    term.focus();
  });
  return b;
}

for (const def of KEYS) keybarEl.append(makeKey(def));

// --- iOS soft-keyboard handling: lift the bottom bar above the keyboard -----
function updateKeyboardOffset(): void {
  const vv = window.visualViewport;
  const offset = vv
    ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    : 0;
  root.style.setProperty('--kb-offset', `${offset}px`);
  fit();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
}

// --- restore persisted preferences -----------------------------------------
try {
  const savedFont = localStorage.getItem('tw.fontSize');
  if (savedFont) {
    const n = parseInt(savedFont, 10);
    if (!Number.isNaN(n)) {
      term.options.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, n));
    }
  }
} catch {
  /* ignore */
}

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

// Initial layout + connect + focus.
fit();
connect();
term.focus();
