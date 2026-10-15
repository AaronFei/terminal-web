// Touch select mode and the selection bar (複製 / 全選 / 取消).

import { SEL_DEBUG } from '../config.js';
import { root } from '../dom.js';
import { activeSession } from '../state.js';
import { flashStatus } from '../status.js';
import { copyText } from '../clipboard.js';
import { cssPx } from '../layout.js';

// Touch "select" mode (toggled from the key bar). tmux runs with `mouse on`, so
// a finger drag is normally hijacked for scrolling and there is no way to make a
// text selection by touch (on desktop you hold Option to bypass tmux's mouse
// reporting; a tablet has no such key). While this is on, a one-finger drag
// selects text instead of scrolling, and the selection bar's 複製 copies it.
export let touchSelectMode = false;
// The key bar's 選取 key, set when the key bar is built (see ui/keybar.ts).
let selectBtn: HTMLElement | null = null;

export function setSelectBtn(b: HTMLElement): void {
  selectBtn = b;
}

// --- selection actions (touch) ---------------------------------------------
// Copying used to happen the instant you lifted your finger, so one imprecise
// drag decided everything: overshoot and the whole thing started over, and
// there was never a moment where you could see what you were about to get. The
// selection stays up now and these appear above the key bar.
const selBar = document.createElement('div');
selBar.id = 'selbar';
selBar.className = 'hidden';

export function showSelectionBar(): void {
  selBar.classList.remove('hidden');
  if (SEL_DEBUG) {
    const r = selBar.getBoundingClientRect();
    activeSession?.debugSend(
      'sel-bar',
      `show at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} ` +
        `inDom=${selBar.isConnected ? 1 : 0} kbGap=${cssPx(root, '--kb-gap')} keybar=${cssPx(root, '--keybar-h')}`,
    );
  }
}
export function hideSelectionBar(): void {
  if (SEL_DEBUG && !selBar.classList.contains('hidden')) {
    activeSession?.debugSend('sel-bar', 'hide');
  }
  selBar.classList.add('hidden');
}

/** Turn touch-select mode on or off, keeping the key and the bar in step. */
export function setTouchSelectMode(on: boolean): void {
  touchSelectMode = on;
  selectBtn?.classList.toggle('armed', on);
  if (!on) {
    activeSession?.clearSelectionRange();
    hideSelectionBar();
  }
}

/** Copy whatever is selected, then leave select mode. */
export function copySelectionNow(): void {
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

export function buildSelBar(): void {
  document.body.append(selBar);
}
