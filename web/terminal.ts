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
// WebGL renderer is on by default; ?webgl=0 (or ?nowebgl) falls back to the DOM
// renderer — useful for flaky GPUs or headless capture.
const WEBGL_ENABLED = params.get('webgl') !== '0' && !params.has('nowebgl');

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

// Quick help overlay: how to copy / paste / attach files. Shown from the "?"
// button and once automatically on first visit.
function openHelp(): void {
  if (document.querySelector('.help-overlay')) return;
  const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
  const selKey = isMac ? '⌥ Option' : 'Shift';
  const pasteKey = isMac ? '⌘V' : 'Ctrl+Shift+V';
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay help-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box help-box';
  box.innerHTML =
    '<div class="help-title">How to copy / paste / files</div>' +
    '<ul class="help-list">' +
    `<li><b>Copy</b> — hold <b>${selKey}</b> and drag to select; it copies automatically. (Or select, then tap <b>Copy</b>.)</li>` +
    `<li><b>Paste</b> — click the terminal, then <b>${pasteKey}</b>. On a phone/tablet, tap <b>Paste</b> and paste into the box that appears.</li>` +
    '<li><b>Attach a file</b> (for Claude Code etc.) — tap the 📎 button, or paste / drag any file (image, PDF, text…): it uploads and inserts the file path. Then press Enter.</li>' +
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
  try {
    localStorage.setItem('tw.helpSeen', '1');
  } catch {
    /* ignore */
  }
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
  // True once the socket has opened at least once — i.e. the server has seen
  // (and registered) this session. The cross-device sync only ever removes
  // sessions that have connected, so a brand-new tab mid-connect is never
  // mistaken for one closed elsewhere.
  everConnected = false;

  private readonly fitAddon = new FitAddon();
  private ws: WebSocket | null = null;
  private reconnectDelay = MIN_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // IME double-input guard (order-independent, content-scoped).
  private lastData = '';
  private lastDataAt = 0;

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
    this.wireTouchScroll();
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

    this.el.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.touches.length !== 1) {
          tracking = false;
          return;
        }
        const t = e.touches[0];
        startX = t.clientX;
        startY = lastY = t.clientY;
        tracking = true;
        scrolling = false;
        // Cell under the finger, so tmux targets the right pane if it's split.
        const rect = this.el.getBoundingClientRect();
        const cw = rect.width / Math.max(1, this.term.cols);
        const ch = rect.height / Math.max(1, this.term.rows);
        col = Math.max(1, Math.min(this.term.cols, Math.floor((t.clientX - rect.left) / cw) + 1));
        row = Math.max(1, Math.min(this.term.rows, Math.floor((t.clientY - rect.top) / ch) + 1));
      },
      { capture: true, passive: true },
    );

    this.el.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (!tracking || e.touches.length !== 1) return;
        const t = e.touches[0];
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

    const end = (): void => {
      tracking = false;
      scrolling = false;
    };
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

  // Ask the server to kill this tmux session for good (used on tab close).
  kill(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'kill' }));
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
    const url = `${wsProto}://${window.location.host}/ws?session=${encodeURIComponent(this.name)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectDelay = MIN_DELAY;
      this.everConnected = true;
      this.setConnected(true);
      this.fit();
      this.startPing();
      // Re-assert a custom label: the server stores it on the tmux session
      // (@twlabel), which is wiped when the session is killed+recreated by a
      // restart, so a renamed tab would otherwise revert to its raw name.
      if (this.displayName !== this.name) renameOnServer(this.name, this.displayName);
      if (isActive(this)) this.term.focus();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as { type?: string };
          // The session was closed (killed) here or on another device: drop the
          // tab and do NOT reconnect — reconnecting would recreate the session
          // via `new-session -A`, resurrecting what was just closed.
          if (msg && msg.type === 'closed') {
            recentlyClosed.set(this.name, performance.now());
            removeLocalSession(this);
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
  if (activeSession && activeSession.connected) hideStatus();
  else showStatus('reconnecting…');
}

function updateTabDot(s: Session): void {
  s.tabDot?.classList.toggle('connected', s.connected);
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

  // Single tap activates; a second tap within 350ms renames the tab. Manual
  // detection (rather than a `dblclick` listener) because the pointerdown
  // preventDefault below suppresses the synthesized click/dblclick events, and
  // this also gives touch devices a double-tap-to-rename gesture.
  let lastTap = 0;
  tab.addEventListener('pointerdown', (e) => {
    if (e.target === close) return;
    e.preventDefault();
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

function addSession(name: string, makeActive: boolean, displayName?: string): Session {
  let s = sessions.find((x) => x.name === name);
  if (!s) {
    s = new Session(name, displayName);
    sessions.push(s);
    buildTab(s);
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
  reflectActiveStatus();
  refreshMobileUI();
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

function promptAddSession(): void {
  const suggestion = nextSessionName();
  const raw = window.prompt('New session name:', suggestion);
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
function promptRenameSession(s: Session): void {
  const raw = window.prompt(
    `Rename tab (display only — the tmux session stays "${s.name}"):`,
    s.displayName,
  );
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

    // Expire stale close-guards first so re-opening a name later still works.
    const now = performance.now();
    for (const [name, at] of recentlyClosed) {
      if (now - at > CLOSE_GUARD_MS) recentlyClosed.delete(name);
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

    // Remove tabs closed elsewhere. Only sessions that have actually connected
    // (so the server knows them) are eligible — never a still-connecting new tab.
    for (const s of sessions.slice()) {
      if (byName.has(s.name)) continue;
      if (!s.everConnected) continue;
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

// Below this width the key bar wraps to several rows (see styles.css) instead
// of being one horizontally-scrollable row, so its height is no longer fixed.
const mobileMQ = window.matchMedia('(max-width: 640px)');

// Publish the key bar's real height into --keybar-h so the terminal sits right
// above it: a fixed value on desktop (single row), the measured wrapped height
// on a phone.
function updateKeybarHeight(): void {
  if (keybarEl.classList.contains('hidden')) {
    root.style.setProperty('--keybar-h', '0px');
    return;
  }
  const h = mobileMQ.matches ? keybarEl.offsetHeight : KEYBAR_HEIGHT;
  root.style.setProperty('--keybar-h', `${h}px`);
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

function updateKeyboardOffset(): void {
  const vv = window.visualViewport;
  const raw = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  // Only a real soft keyboard (>~250px) takes up meaningful height. In a
  // standalone PWA, window.innerHeight includes the status-bar + home-indicator
  // areas that visualViewport.height excludes, so with no keyboard `raw` is the
  // safe-area sum (~95–110px) — ignore anything below 150px so that isn't
  // mistaken for a keyboard and left as a gap at the bottom.
  const offset = raw > 150 ? raw : 0;
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
// Monochrome paperclip icon (matches the other glyphs; uses currentColor).
const fileBtn = document.createElement('button');
fileBtn.className = 'tb-btn tb-icon';
fileBtn.type = 'button';
fileBtn.title = 'Attach a file (upload + insert path)';
fileBtn.setAttribute('aria-label', 'Attach a file');
fileBtn.innerHTML =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 ' +
  '5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>';
// Use a real click (not pointerdown+preventDefault): iOS blocks opening a file
// picker from a preventDefaulted pointer event, so the attach button did nothing
// on phones.
fileBtn.addEventListener('click', () => fileInput.click());
controlsEl.append(fileBtn);

makeButton(controlsEl, 'tb-btn tb-icon', '⤢', 'Toggle fullscreen', toggleFullscreen);
makeButton(controlsEl, 'tb-btn tb-icon', '?', 'Help: copy / paste / files', openHelp);

// --- on-screen key bar (sends to the active session) -----------------------
interface KeyDef {
  label?: string;
  seq?: string;
  mod?: 'ctrl' | 'alt';
  action?: 'copy' | 'paste';
  /** Force a line break here (mobile only): the keys after it wrap to a new row. */
  rowBreak?: boolean;
}
const KEYS: KeyDef[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: '^C', seq: '\x03' },
  // On a phone the arrows get their own second row; everything else stays on the first.
  { rowBreak: true },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
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
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // On touch, never refocus the terminal: focusing its textarea pops up the
    // soft keyboard. The keys send their bytes straight over the WebSocket, so
    // focus isn't needed — preventDefault already keeps whatever focus state
    // (and thus the keyboard) the user already had.
    const refocus = e.pointerType !== 'touch';
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
  activeSession?.focus();
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

function sheetRow(ico: string, label: string, onTap: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sheet-row';
  b.type = 'button';
  const i = document.createElement('span');
  i.className = 'sheet-ico';
  i.textContent = ico;
  const t = document.createElement('span');
  t.textContent = label;
  b.append(i, t);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onTap();
  });
  return b;
}

sheet.append(
  sheetGrip,
  sheetTitle,
  fontRow,
  sheetRow('⟳', 'Restart this session', () => {
    closeSheet();
    activeSession?.restart();
    activeSession?.focus();
  }),
  sheetRow('📋', 'Paste', () => {
    closeSheet();
    pasteFromClipboard();
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
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
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

async function uploadFile(file: Blob, name?: string): Promise<void> {
  if (!file) return;
  showStatus('uploading file…');
  try {
    const res = await fetch(
      '/upload' + (name ? `?name=${encodeURIComponent(name)}` : ''),
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
    if (!res.ok) {
      flashStatus('file upload failed', 2500);
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
    flashStatus(`file added: ${data.path ?? ''}`, 2500);
  } catch {
    flashStatus('file upload failed', 2500);
  }
}

// Capture phase: xterm's own paste handler calls stopPropagation() on its
// textarea/element, so a bubble-phase listener would never see pastes made into
// the focused terminal. Capturing lets us intercept file pastes first. Any file
// kind is uploaded; plain-text pastes fall through to xterm untouched.
window.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return; // no file: let xterm handle a text paste
    e.preventDefault();
    e.stopImmediatePropagation(); // don't let xterm also handle it
    for (const f of files) void uploadFile(f, f.name);
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
  const server = await fetchServerTabs();
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
  return window.matchMedia('(pointer: coarse)').matches;
})();
setKeybarVisible(keybarDefault);

// First visit: show the copy/paste/image hint once.
try {
  if (!localStorage.getItem('tw.helpSeen')) window.setTimeout(openHelp, 700);
} catch {
  /* ignore */
}
