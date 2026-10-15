// The status toast (#status).

import { statusEl } from './dom.js';
import { activeSession } from './state.js';

export function showStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.add('visible');
}
function hideStatus(): void {
  statusEl?.classList.remove('visible');
}

export function reflectActiveStatus(): void {
  if (!activeSession || activeSession.connected) hideStatus();
  // A terminal being opened for the first time is attaching, not reconnecting;
  // its socket opens on the next frame (see setShown).
  else if (!activeSession.started) hideStatus();
  else showStatus('reconnecting…');
}

export function flashStatus(text: string, ms: number): void {
  showStatus(text);
  window.setTimeout(() => {
    if (statusEl?.textContent === text) hideStatus();
  }, ms);
}

// flashStatus for a message shown during an outage: when it ends, put
// "reconnecting…" back instead of leaving the bar empty while still down.
export function flashWhileDown(text: string, ms: number): void {
  flashStatus(text, ms);
  window.setTimeout(() => {
    if (!statusEl?.classList.contains('visible')) reflectActiveStatus();
  }, ms);
}
