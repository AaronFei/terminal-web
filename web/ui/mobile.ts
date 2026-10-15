import { TOUCH_DEVICE } from '../config.js';
import { keybarEl } from '../dom.js';
import { activeSession, activeTab, currentFont, sessions } from '../state.js';
import { flashStatus } from '../status.js';
import { openHelp } from '../overlays.js';
import { promptDownload } from '../transfer.js';
import { pasteFromClipboard } from '../clipboard.js';
import { LAYOUT_BUTTONS, sheetLayoutButtons } from '../layout.js';
import { copySelectionNow } from './selbar.js';
import type { Session } from '../session.js';
import {
  activateSession,
  confirmCloseSession,
  onTap,
  promptAddSession,
  promptRenameSession,
} from '../tabs.js';
import { setKeybarVisible } from './keybar.js';
import { changeFont, fileInput, refocusTerminal, toggleFullscreen } from './topbar.js';

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
drawerOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === drawerOverlay) closeDrawer();
});

let drawerOpen = false;
// Each row's status dot, so a change of connection can be shown in place
// (see updateTabDot) instead of by building the list again.
export const drawerDots = new Map<Session, HTMLElement>();

function renderDrawer(): void {
  drawerList.textContent = '';
  drawerDots.clear();
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'drawer-row' + (s === activeTab ? ' active' : '');

    const body = document.createElement('div');
    body.className = 'drawer-body';
    const dot = document.createElement('span');
    dot.className = 'tab-dot' + (s.connected ? ' connected' : '') + (s.started ? '' : ' idle');
    drawerDots.set(s, dot);
    const name = document.createElement('span');
    name.className = 'drawer-name';
    name.textContent = s.displayName;
    body.append(dot, name);
    // Taps only: this list scrolls, and a swipe through it must not pick the
    // session it started on (it used to, on pointerdown).
    onTap(body, () => {
      activateSession(s);
      closeDrawer();
    }, drawer);

    const rename = document.createElement('button');
    rename.className = 'drawer-act';
    rename.type = 'button';
    rename.textContent = '✎';
    rename.title = 'Rename tab';
    onTap(rename, () => {
      promptRenameSession(s);
      renderDrawer();
    }, drawer);

    const close = document.createElement('button');
    close.className = 'drawer-act danger';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close tab & kill session';
    onTap(close, () => {
      closeDrawer();
      confirmCloseSession(s);
    }, drawer);

    row.append(body, rename, close);
    drawerList.append(row);
  }
}

export function openDrawer(): void {
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
export function updateFontVal(): void {
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
    activeTab?.setView(def.mode);
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
    refocusTerminal();
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
sheetOverlay.addEventListener('pointerdown', (e) => {
  if (e.target === sheetOverlay) closeSheet();
});

export function openSheet(): void {
  updateFontVal();
  sheetOverlay.classList.remove('hidden');
}
function closeSheet(): void {
  sheetOverlay.classList.add('hidden');
}

// Keep the mobile bar's title + connection dot current, and re-render the open
// drawer when the session list or the active tab changes. A change of
// connection alone goes through updateTabDot, which leaves the list standing.
export function refreshMobileUI(): void {
  refreshMobileTitle();
  if (drawerOpen) renderDrawer();
}
export function refreshMobileTitle(): void {
  const s = activeTab;
  mTitleLabel.textContent = s ? s.displayName : '—';
  mTitleDot.classList.toggle('connected', !!s?.connected);
  mKeysBtn.classList.toggle('active', !keybarEl.classList.contains('hidden'));
}

export function buildMobile(): void {
  document.body.append(mobilebar);
  document.body.append(drawerOverlay);
  document.body.append(sheetOverlay);
  refreshMobileUI();
}
