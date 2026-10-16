// The on-screen key bar: showing it, and its keys.

import { keybarEl } from '../dom.js';
import { activeSession } from '../state.js';
import { flashWhileDown } from '../status.js';
import { savePrefs } from '../api.js';
import { fitActive, updateKeybarHeight } from '../layout.js';
import { keysBtn } from './topbar.js';
import { refreshMobileUI } from './mobile.js';

export function setKeybarVisible(visible: boolean): void {
  keybarEl.classList.toggle('hidden', !visible);
  keysBtn.classList.toggle('active', visible);
  refreshMobileUI();
  try {
    localStorage.setItem('tw.keybar', visible ? '1' : '0');
  } catch {
    /* ignore */
  }
  savePrefs({ keybar: visible });
  requestAnimationFrame(() => {
    updateKeybarHeight();
    fitActive();
  });
}

// --- on-screen key bar (sends to the active session) -----------------------
interface KeyDef {
  label?: string;
  seq?: string;
  mod?: 'ctrl' | 'alt';
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
  // On a phone the arrows get their own second row; everything else stays on the first.
  { rowBreak: true },
  // Ctrl+End: jump to the bottom in Claude Code's fullscreen view (CSI 1;5F).
  { label: '^End', seq: '\x1b[1;5F' },
  // Ctrl+X then Ctrl+S — emacs's save — as one tap: two chords in a row is a lot
  // of Ctrl-arming on a phone.
  { label: '^X^S', seq: '\x18\x13' },
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

// A key-bar press made while disconnected is dropped; say so, but at most once
// per KEY_DROP_FLASH_MS so mashing the keys doesn't keep re-flashing it.
const KEY_DROP_FLASH_MS = 1500;
let keyDropFlashAt = -Infinity;
function flashKeyDropped(): void {
  const now = performance.now();
  if (now - keyDropFlashAt < KEY_DROP_FLASH_MS) return;
  keyDropFlashAt = now;
  flashWhileDown('未連線，按鍵沒有送出', KEY_DROP_FLASH_MS);
}

export function buildKeybar(): void {
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
      if (def.mod) {
        if (def.mod === 'ctrl') ctrlArmed = !ctrlArmed;
        else altArmed = !altArmed;
        refreshModVisuals();
        return;
      }
      if (def.seq !== undefined && activeSession && !activeSession.sendKey(applyMods(def.seq))) {
        flashKeyDropped();
      }
      if (ctrlArmed || altArmed) {
        ctrlArmed = false;
        altArmed = false;
        refreshModVisuals();
      }
      if (refocus) activeSession?.focus();
    });
    keybarEl.append(b);
  }
}
