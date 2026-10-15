// The page elements everything else hangs off.

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
export const root = document.documentElement;
const topbar = document.getElementById('topbar') as HTMLElement;
export const termArea = document.getElementById('terminal') as HTMLElement;
export const keybarEl = document.getElementById('keybar') as HTMLElement;
export const statusEl = document.getElementById('status');

// Top bar layout: [ tabs (scrollable) ... + ] [ controls ]
export const tabsEl = document.createElement('div');
tabsEl.id = 'tabs';
export const addBtn = document.createElement('button');
addBtn.className = 'tab-add';
addBtn.type = 'button';
addBtn.textContent = '+';
addBtn.title = 'New session';
tabsEl.append(addBtn);

export const controlsEl = document.createElement('div');
controlsEl.id = 'controls';

export function buildTopbarShell(): void {
  topbar.append(tabsEl, controlsEl);
}
