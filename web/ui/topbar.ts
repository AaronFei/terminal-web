import { MAX_FONT, MIN_FONT, TOUCH_DEVICE } from '../config.js';
import { addBtn, controlsEl, keybarEl, root } from '../dom.js';
import { activeSession, activeTab, currentFont, sessions, setCurrentFont } from '../state.js';
import { openHelp } from '../overlays.js';
import { promptDownload, uploadFile } from '../transfer.js';
import { savePrefs } from '../api.js';
import { LAYOUT_BUTTONS, fitActive, layoutButtons } from '../layout.js';
import { promptAddSession } from '../tabs.js';
import { setKeybarVisible } from './keybar.js';
import { openDrawer, openSheet } from './mobile.js';

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

// Give the keys back to the terminal after a control is used — on a desktop.
// On touch, focus() raises the soft keyboard (see activateSession and
// closeDrawer), so an iPad's ⌨, ⟳, 1/2/⊞ or A± popped it up every time; there
// the control's preventDefaulted pointerdown has already left focus, and the
// keyboard, as they were.
export function refocusTerminal(): void {
  if (!TOUCH_DEVICE) activeSession?.focus();
}

export function changeFont(delta: number): void {
  setCurrentFont(Math.min(MAX_FONT, Math.max(MIN_FONT, currentFont + delta)));
  try {
    localStorage.setItem('tw.fontSize', String(currentFont));
  } catch {
    /* ignore */
  }
  savePrefs({ fontSize: currentFont });
  for (const s of sessions) {
    s.setFont(currentFont);
    s.mate?.setFont(currentFont); // a second half is not in `sessions`
  }
  fitActive(); // the cell size changed: re-measure and push the new size to all panes
  refocusTerminal();
}

export function toggleFullscreen(): void {
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
export const keysBtn = makeButton(controlsEl, 'tb-btn tb-icon', '⌨', 'Toggle on-screen keys', () => {
  setKeybarVisible(keybarEl.classList.contains('hidden'));
  refocusTerminal();
});
makeButton(controlsEl, 'tb-btn tb-icon', '⟳', 'Restart this session', () => {
  activeSession?.restart();
  refocusTerminal();
});

const layoutSeg = document.createElement('div');
layoutSeg.className = 'tb-seg';
for (const def of LAYOUT_BUTTONS) {
  layoutButtons.set(
    def.mode,
    makeButton(layoutSeg, 'tb-btn', def.label, def.title, () => {
      activeTab?.setView(def.mode);
      refocusTerminal();
    }),
  );
}
controlsEl.append(layoutSeg);

// Reliable file attach for every platform (incl. iPad) and over plain HTTP —
// no clipboard needed: pick any file(s), each uploads and its path is inserted.
export const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.style.display = 'none';
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

export function buildTopbar(): void {
  document.body.append(fileInput);
}
