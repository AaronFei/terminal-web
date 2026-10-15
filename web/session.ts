import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  IME_DEBUG,
  IME_DEDUP_MS,
  MAX_DELAY,
  MAX_PENDING_SEQ,
  MIN_COLS,
  MIN_DELAY,
  MIN_ROWS,
  PING_LATE_MS,
  PING_MS,
  PING_TIMEOUT_MS,
  SEL_DEBUG,
  THEME,
  TOUCH_DEVICE,
  WAKE_PING_MS,
  WEBGL_ENABLED,
  encoder,
  isMac,
  mateNameOf,
  wsProto,
} from './config.js';
import type { LayoutMode } from './config.js';
import { termArea } from './dom.js';
import {
  activeSession,
  activeTab,
  currentFont,
  isActive,
  recentlyClosed,
  sessions,
  setActiveSession,
} from './state.js';
import { flashStatus, flashWhileDown, reflectActiveStatus, showStatus } from './status.js';
import { copyText, pasteRich } from './clipboard.js';
import { renameOnServer, saveTabs } from './api.js';
import {
  focusPane,
  keyboardUp,
  layOutTab,
  paneCols,
  paneRows,
  refreshLayoutUI,
  scheduleKeyboardOffset,
  setPaneDims,
} from './layout.js';
import { hideSelectionBar, showSelectionBar, touchSelectMode } from './ui/selbar.js';

// The tab strip and the sessions drawer are built on top of Session, so it
// reaches them through these hooks, set once by terminal.ts at startup, rather
// than by importing them back (an import cycle).
export interface SessionHooks {
  updateTabDot(s: Session): void;
  removeLocalSession(s: Session): void;
}
let hooks: SessionHooks;
export function setSessionHooks(h: SessionHooks): void {
  hooks = h;
}
function updateTabDot(s: Session): void {
  hooks.updateTabDot(s);
}
function removeLocalSession(s: Session): void {
  hooks.removeLocalSession(s);
}

// ---------------------------------------------------------------------------
// Session: one terminal + one WebSocket + reconnect, rendered in its own pane.
// ---------------------------------------------------------------------------
export class Session {
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

  // Sharing the screen with the other half of a split, rather than having it to
  // itself. Set by layOutTab; read where a full-width measurement is meant.
  half = false;

  private readonly fitAddon = new FitAddon();
  private ws: WebSocket | null = null;
  private reconnectDelay = MIN_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  // When pingTimer was meant to fire, to tell a late tick from a frozen page.
  private pingTickAt = 0;
  // The last time anything arrived on the socket.
  private lastRxAt = 0;
  // When the oldest ping not yet answered went out (0: none out), and by when
  // something has to have arrived.
  private pingSentAt = 0;
  private pingDue = 0;
  private disposed = false;
  // Until when a connect may create this session if it is not there. The
  // server refuses to bring back a closed tab for a connect that does not ask
  // (see closedTabs in server.ts) — only a tab made on purpose asks, and only
  // for its first attach, so a page that sleeps for a day and wakes up cannot
  // pass for one.
  private createUntil = 0;

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

  // Discrete injections (file path, paste) buffered while the WS is
  // not OPEN, flushed on the next reconnect (see connect's onopen). Raw typing
  // is never buffered — only these one-shot sends routed through sendSeq().
  private pendingSeq: string[] = [];

  // Set by restart(), used up by the next socket to open: that reconnect is
  // into a session made from scratch, which has lost the label (see onopen).
  private relabelOnOpen = false;

  // Which of this tab's two terminals is on screen. A per-device choice now
  // that the pair is two sessions rather than one tmux window: a phone and a
  // desktop looking at the same work want different answers to it.
  view: LayoutMode = 'one';
  // The session beside this one, built the first time it is asked for. Null on
  // a tab that has never been split, and always null on a mate itself.
  mate: Session | null = null;
  // True on the second session of a pair. It is an ordinary session in every
  // other way; this only keeps it out of the tab strip and its own recursion.
  readonly isMate: boolean;

  constructor(name: string, displayName?: string, isMate = false) {
    this.name = name;
    this.displayName = displayName?.trim() || name;
    this.isMate = isMate;
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: currentFont,
      // Next to nothing ever lands here. The pty runs tmux, which puts xterm on
      // its alternate screen for as long as it is attached (web.tmux.conf does
      // not override smcup/rmcup), and the alternate screen has no scrollback;
      // the history you scroll through is tmux's own, reached through copy-mode
      // by the wheel and by touch (see wireTouchScroll). 100000 here only
      // reserved room for lines that never come.
      scrollback: 1000,
      allowProposedApi: true,
      // Hold Option (macOS) / Shift (others) and drag to select text even while
      // tmux mouse mode is on, so it can be copied.
      macOptionClickForcesSelection: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());
    this.term.onRender(() => {
      if (keyboardUp && this === activeSession) scheduleKeyboardOffset();
    });

    this.el = document.createElement('div');
    this.el.className = 'term-pane hidden';
    termArea.append(this.el);
    this.term.open(this.el);
    // The WebGL renderer is not loaded here but when this terminal is first
    // shown (see loadWebgl).

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

    // With two terminals on screen, something has to say which one the key bar,
    // a paste and an uploaded file are meant for. Touching one is that
    // something — the same gesture that focuses it for typing.
    this.el.addEventListener('pointerdown', () => focusPane(this), { capture: true });
    this.term.textarea?.addEventListener('focus', () => focusPane(this));

    this.wireInput();
    this.wireTouchScroll();
    this.wireHandles();
  }

  /**
   * A cell's size and where the grid starts: `left`/`top` on the page, and
   * `offX`/`offY` from the pane's padding box, which is what the selection
   * handles are positioned in. Measured off xterm's own .xterm-screen, which is
   * exactly cols x rows cells. The pane is not: it has its padding, whatever
   * FitAddon could not fit a whole cell into, and on a desktop the scrollbar —
   * divide that by the column count and the error grows a little every column,
   * so a touch near the right edge lands a cell or two short.
   */
  private cellSize(): { w: number; h: number; left: number; top: number; offX: number; offY: number } {
    const screen = this.el.querySelector<HTMLElement>('.xterm-screen') ?? this.el;
    const rect = screen.getBoundingClientRect();
    const pane = this.el.getBoundingClientRect();
    return {
      w: Math.max(1, rect.width) / Math.max(1, this.term.cols),
      h: Math.max(1, rect.height) / Math.max(1, this.term.rows),
      left: rect.left,
      top: rect.top,
      offX: rect.left - pane.left - this.el.clientLeft,
      offY: rect.top - pane.top - this.el.clientTop,
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
        `a=${a[0]},${a[1]} b=${b[0]},${b[1]} ` +
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
    // One terminal, one selection that flows through it. The second session of
    // a split is a terminal of its own with a selection of its own, so nothing
    // here has to be kept on one side of a line drawn in the text.
    const length = (eRow - sRow) * this.term.cols + (eCol - sCol) + 1;
    try {
      this.term.select(sCol, sRow, length);
    } catch {
      /* out of range after a redraw — leave the selection as it was */
    }
    this.positionHandles(sCol, sRow, eCol, eRow);
    // Whatever made or changed this selection — a drag, a handle, a long press,
    // 全選 — if it was a finger then its actions belong on screen. Leaving that
    // to each caller is how a path ends up with a selection and no way to copy
    // it, which is exactly what happened.
    if (this.lastInputWasTouch && this.term.hasSelection()) showSelectionBar();
  }

  private positionHandles(sCol: number, sRow: number, eCol: number, eRow: number): void {
    if (!this.handleA || !this.handleB) return;
    // Only for a selection made by touch: a pointer puts one where it wants
    // first time, and two blue circles on a desktop terminal are in the way.
    // Judged by how this selection was made rather than by what the device
    // claims to be — a machine with both gets each kind right that way.
    if (!this.lastInputWasTouch) {
      if (SEL_DEBUG) this.debugSend('sel-handles', 'skipped: last input was not touch');
      return;
    }
    if (SEL_DEBUG) this.debugSend('sel-handles', `at ${sCol},${sRow}-${eCol},${eRow}`);
    const cell = this.cellSize();
    const viewTop = this.term.buffer.active.viewportY;
    const place = (h: HTMLElement, col: number, row: number, below: boolean): void => {
      h.style.left = `${cell.offX + col * cell.w}px`;
      h.style.top = `${cell.offY + (row - viewTop + (below ? 1 : 0)) * cell.h}px`;
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

  /**
   * The run of word-ish characters around a cell, as a range of cells.
   *
   * Walked cell by cell rather than through translateToString, which gives one
   * string index per character: a CJK character or an emoji takes two cells,
   * so on any line with one in it the string index and the column part ways,
   * and the word found was some way left of the finger.
   */
  wordRangeAt(col: number, row: number): [[number, number], [number, number]] | null {
    const buf = this.term.buffer.active;
    const line = buf.getLine(row);
    if (!line) return null;
    const scratch = buf.getNullCell();
    // A wide character's second cell has width 0 and no characters of its own;
    // the character is the one in the cell before.
    const lead = (x: number): number => (x > 0 && line.getCell(x, scratch)?.getWidth() === 0 ? x - 1 : x);
    const width = (x: number): number => Math.max(1, line.getCell(x, scratch)?.getWidth() ?? 1);
    const isWord = (x: number): boolean => {
      const ch = line.getCell(x, scratch)?.getChars() ?? '';
      return !!ch && !/\s/.test(ch);
    };
    const at = lead(col);
    if (!isWord(at)) return null;
    let a = at;
    while (a > 0 && isWord(lead(a - 1))) a = lead(a - 1);
    // b is the last cell of the last character, so a wide one is taken whole.
    let b = at + width(at) - 1;
    while (b + 1 < line.length && isWord(b + 1)) b = b + 1 + width(b + 1) - 1;
    return [
      [a, row],
      [Math.min(b, line.length - 1), row],
    ];
  }

  /**
   * Attach this terminal: open its socket, which spawns its pty and its tmux
   * client. Called the first time it is shown (see setShown), never before — a
   * tab you have not looked at, and a split you have not asked for, cost
   * nothing. Idempotent; a reconnect in flight counts as started.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // Open at the size this pane is really going to be, so the pty spawns at it
    // and tmux never has to resize the window afterwards. One on screen has
    // just measured itself — setShown fits before it starts — and one that is
    // not takes the last full-pane measurement.
    if (this.el.classList.contains('hidden') && paneCols && paneRows) {
      this.applyDims(paneCols, paneRows);
    }
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
   * Send a discrete injection (paste, uploaded file path).
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
    else flashWhileDown('not sent: too much to hold while reconnecting', 2500);
  }

  /**
   * Send a key-bar press. Dropped, like a typed key, while the socket is down:
   * replaying arrows, Enter or ^C minutes later can run a command again.
   * Returns whether it was sent.
   */
  sendKey(seq: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send(seq);
    return true;
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
          this.clearSelectionRange();
          hideSelectionBar();
          return;
        }
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
          this.setSelectionRange(range[0], range[1]);
          showSelectionBar();
        }, 500);
        tracking = true;
        scrolling = false;
        // Cell under the finger, the position the wheel events report to tmux.
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
          // Ordering and placing the handles live in setSelectionRange — the
          // drag just says where the two ends are, exactly as dragging a handle
          // afterwards does.
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

    // A finished touch gesture. Nothing is copied here — copySelection in the
    // constructor runs on mouseup, which a touch drag does not produce; a touch
    // selection waits for 複製 on the selection bar. A tap with no drag left the
    // selection cleared. Select mode stays armed until toggled off again.
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
    // A gesture the system takes over (a long press it decides is its own, an
    // edge swipe) ends in touchcancel, with no touchend to use up pressFired —
    // and left set, it swallowed the next tap's touchend instead.
    this.el.addEventListener(
      'touchcancel',
      () => {
        pressFired = false;
      },
      { capture: true, passive: true },
    );
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
    // Only a full-width pane speaks for the tabs that cannot measure themselves.
    // Half of a split is not the size they will open at.
    if (!this.half) setPaneDims(this.term.cols, this.term.rows);
  }

  /**
   * How far below the top of #terminal the last thing worth seeing ends: the
   * lower of the cursor row and the last non-blank row on screen. Measured
   * from #terminal rather than from this pane, because in a stacked split the
   * bottom half starts halfway down and the keyboard slides both halves.
   */
  contentBottomPx(): number {
    const buf = this.term.buffer.active;
    const rows = this.term.rows;
    // cursorY counts from the bottom page of the buffer, not from what is on
    // screen; scrolled back into history, the cursor may be below the view.
    let last = Math.min(rows - 1, Math.max(0, buf.baseY + buf.cursorY - buf.viewportY));
    for (let y = rows - 1; y > last; y -= 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line && line.translateToString(true).trim() !== '') {
        last = y;
        break;
      }
    }
    const screen = this.el.querySelector<HTMLElement>('.xterm-screen') ?? this.el;
    const box = screen.getBoundingClientRect();
    // Both rects carry the same --kb-offset transform, so it cancels out.
    const top = box.top - termArea.getBoundingClientRect().top;
    return top + ((last + 1) * box.height) / rows;
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

  /**
   * Select everything on screen. This is the copy most often wanted on a phone,
   * where dragging out an exact range is the hard part — and with the split
   * being two terminals, "on screen" needs no qualification any more.
   */
  selectVisible(): boolean {
    const top = this.term.buffer.active.viewportY;
    const bottom = top + this.term.rows - 1;
    this.setSelectionRange([0, top], [this.term.cols - 1, bottom]);
    return this.term.hasSelection();
  }

  /**
   * The second session beside this one, built on first use.
   *
   * Nothing is asked of tmux to make it: the socket attaches with
   * `new-session -A`, which creates the session if it is not there and picks up
   * whatever was left in it if it is. So the pair survives a reload, a reboot
   * and a restore, and a tab that is never split never costs a second anything.
   */
  ensureMate(): Session | null {
    if (this.isMate) return null;
    if (!this.mate) {
      this.mate = new Session(mateNameOf(this.name), undefined, true);
      this.mate.intendCreate(); // made by pressing 2 or ⊞, or a split this device kept
    }
    return this.mate;
  }

  /** This session is being made on purpose: its first attach may create it. */
  intendCreate(): void {
    this.createUntil = performance.now() + 60_000;
  }

  /** Show one of this tab's terminals, or both. */
  setView(mode: LayoutMode): void {
    if (this.isMate) return;
    this.view = mode;
    if (mode !== 'one') this.ensureMate();
    layOutTab(this);
    saveTabs();
    refreshLayoutUI();
  }

  /** Re-state our size on a freshly opened socket, and re-measure if shown. */
  private resync(): void {
    if (this.el.classList.contains('hidden')) this.sendResize();
    else this.fit(); // re-measures and sends as a side effect
  }

  setFont(px: number): void {
    this.term.options.fontSize = px;
  }

  /**
   * Show or hide this one terminal. Where it goes on screen is the tab's
   * business — see layOutTab — because with a split that depends on what the
   * other one is doing.
   */
  setShown(shown: boolean): void {
    this.el.classList.toggle('hidden', !shown);
    if (!shown) {
      this.clearSelectionRange(); // a selection belongs to what is on screen
      return;
    }
    requestAnimationFrame(() => {
      // Hidden again before this frame came round: a tab flicked past on the
      // way to another one. It was never looked at, so it does not attach.
      if (this.disposed || this.el.classList.contains('hidden')) return;
      // Before fit: the renderer is what measures the cells it fits to.
      this.loadWebgl();
      this.fit();
      // Attach now, not at page load: this is the first frame where this pane
      // is laid out, so fit() has the real size to hand the server.
      this.start();
    });
  }

  /**
   * Switch to the WebGL renderer, once, the first time this terminal is on
   * screen. Every tab used to take a WebGL context the moment it was built,
   * mates and tabs nobody ever opened included — and a browser only keeps so
   * many: Chrome drops the oldest past 16, and an iPhone can kill the page for
   * the memory. A terminal never shown never needs one. If it cannot be had, or
   * the context is lost later, xterm carries on with its DOM renderer; the
   * addon goes with the terminal when it is disposed.
   */
  private webglTried = false;
  private loadWebgl(): void {
    if (this.webglTried || !WEBGL_ENABLED) return;
    this.webglTried = true;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      /* fall back to the DOM renderer */
    }
  }

  focus(): void {
    this.term.focus();
  }

  restart(): void {
    this.term.reset();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'restart' }));
      this.relabelOnOpen = true; // the kill takes @twlabel with it; see onopen
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

  // Heartbeat. The server answers each {type:'ping'} with a pong, and anything
  // at all arriving counts as an answer. A phone that sleeps can come back to a
  // socket that is half open: readyState still says OPEN, the dot stays green,
  // and every key goes nowhere — nothing but an unanswered ping ever shows it.
  // One timer per session does all of it: it pings every PING_MS, and the same
  // timer is brought forward for a check right after the page wakes (wake).
  private startPing(): void {
    this.lastRxAt = performance.now();
    this.pingSentAt = 0;
    this.schedulePing(PING_MS);
  }
  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }
  private schedulePing(ms: number): void {
    this.stopPing();
    this.pingTickAt = performance.now() + ms;
    this.pingTimer = setTimeout(() => this.heartbeat(), ms);
  }

  /** Send a ping that must be answered within `timeout` ms. */
  private ping(timeout: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (!this.pingSentAt || this.lastRxAt >= this.pingSentAt) {
      // Nothing outstanding: this ping starts the clock.
      this.pingSentAt = now;
      this.pingDue = now + timeout;
    } else {
      // One is out already: sending another buys it no more time.
      this.pingDue = Math.min(this.pingDue, now + timeout);
    }
    ws.send(JSON.stringify({ type: 'ping' }));
    this.schedulePing(Math.max(0, Math.min(PING_MS, this.pingDue - now)));
  }

  private heartbeat(): void {
    this.pingTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const unanswered = this.pingSentAt > 0 && this.lastRxAt < this.pingSentAt;
    if (unanswered && now >= this.pingDue) {
      // Far later than it was set for: the page was frozen, and whatever came
      // in meanwhile may still be queued behind this very timer. Ask again
      // rather than condemn a socket on the strength of our own sleep.
      if (now - this.pingTickAt > PING_LATE_MS) {
        this.pingSentAt = 0;
        this.ping(WAKE_PING_MS);
        return;
      }
      this.dropSocket(ws);
      return;
    }
    this.ping(PING_TIMEOUT_MS);
  }

  /**
   * The page is back in view, or back online: find out now whether this
   * terminal's connection survived rather than when the next ping is due. A
   * reconnect waiting out its backoff goes at once; an open socket gets a ping
   * it must answer within WAKE_PING_MS.
   */
  wake(): void {
    if (this.disposed || !this.started) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectDelay = MIN_DELAY;
      this.connect();
      return;
    }
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      // Start the clock over: a ping left over from before the sleep may be
      // long past its deadline, and this check is owed its full WAKE_PING_MS.
      this.pingSentAt = 0;
      this.ping(WAKE_PING_MS);
    } else if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      // Closed, or closing, with no close event to show for it yet — what a
      // page restored from the back/forward cache can be left holding.
      this.dropSocket(ws);
    }
  }

  /**
   * Give up on a socket that stopped answering. close() alone is not enough:
   * on a dead connection the close handshake can take a minute to give up, and
   * until it does no close event comes. So it is cut loose — its handlers
   * removed, so a late close or message cannot touch the connection that
   * replaces it — and the close is handled here, now.
   */
  private dropSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    this.socketClosed(socket);
  }

  private socketClosed(socket: WebSocket): void {
    this.stopPing();
    if (this.ws === socket) this.ws = null;
    this.setConnected(false);
    this.scheduleReconnect();
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
      `&cols=${this.term.cols}&rows=${this.term.rows}` +
      (performance.now() < this.createUntil ? '&create=1' : '');
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectDelay = MIN_DELAY;
      this.createUntil = 0; // it exists now; a later reconnect is only a reconnect
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
      // Only after this device's own restart, though. Any other reconnect is
      // into the same session, label intact — and a phone waking up reconnects
      // before its sync has fetched a name given on another device, so saying
      // its own stale one again would undo that rename everywhere.
      if (this.relabelOnOpen) {
        this.relabelOnOpen = false;
        if (this.displayName !== this.name) renameOnServer(this.name, this.displayName);
      }
      // Re-fit + re-focus so typing resumes smoothly after a reconnect — UNLESS
      // an IME composition is in flight: on iOS these cancel the soft keyboard's
      // active composition, dropping the 注音 candidate bar and turning input
      // raw/direct. Mobile reconnects are frequent, so this otherwise interrupts
      // composing mid-word. Defer to compositionend instead.
      if (this.composing) {
        this.reattachAfterCompose = true;
      } else {
        this.resync();
        // Only the terminal that has the keys (in a split both halves reconnect
        // after a deploy), and never out of something focused on purpose: a
        // rename box, the paste box, a confirm dialog.
        const a = document.activeElement;
        const free = !a || a === document.body || a.classList.contains('xterm-helper-textarea');
        if (activeSession === this && free) this.term.focus();
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      this.lastRxAt = performance.now(); // any message answers a ping
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
            // A mate closing takes the split down, not the tab: the tab is the
            // first session and is still perfectly alive.
            if (this.isMate) {
              const tab = sessions.find((s) => s.mate === this);
              if (tab) {
                // Only the open tab is laid out again. layOutTab shows what it
                // is given, so running it on a tab in the background would put
                // that tab's pane over the one you are looking at and hand it
                // the keys.
                if (tab === activeTab) {
                  tab.setView('one');
                } else {
                  tab.view = 'one';
                  saveTabs();
                }
                tab.mate = null; // pressing 2 or ⊞ again makes a new one
                if (activeSession === this) setActiveSession(tab);
              }
              this.dispose(); // or its socket's close would reconnect it
              return;
            }
            recentlyClosed.set(this.name, performance.now());
            removeLocalSession(this);
          }
        } catch {
          /* ignore */
        }
      }
    };

    socket.onclose = () => this.socketClosed(socket);

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
    this.mate?.dispose(); // the pair goes together, or the second one is orphaned
    this.mate = null;
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
