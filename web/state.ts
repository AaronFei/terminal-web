// The state shared across modules: the tabs, which one is open, which terminal
// has the keys, and the font. One copy each; other modules read these live
// bindings and write through the setters.

import { MAX_FONT, MIN_FONT } from './config.js';
import type { Session } from './session.js';

export let currentFont = (() => {
  try {
    const n = parseInt(localStorage.getItem('tw.fontSize') ?? '', 10);
    if (!Number.isNaN(n)) return Math.min(MAX_FONT, Math.max(MIN_FONT, n));
  } catch {
    /* ignore */
  }
  return 14;
})();

export function setCurrentFont(px: number): void {
  currentFont = px;
}

// The tabs — first sessions only. A mate is reached through its tab's `mate`,
// never listed here, so everything that walks this list (the strip, the drawer,
// the cross-device sync, the size broadcast) goes on seeing one thing per tab.
export const sessions: Session[] = [];
// The tab that is open, and the one of its (up to two) terminals that typing,
// pasting, copying and an uploaded file are meant for. On an unsplit tab they
// are the same session; a tab is never open without a focused terminal.
export let activeTab: Session | null = null;
export let activeSession: Session | null = null;

export function setActiveTab(s: Session | null): void {
  activeTab = s;
}

export function setActiveSession(s: Session | null): void {
  activeSession = s;
}

/**
 * Whether this terminal is one of the ones currently on screen. The same rule
 * layOutTab shows them by: the open tab's first terminal unless it is on 'two',
 * its second unless it is on 'one'. Being the open tab is not enough — on 'two'
 * the first one is hidden, and a toast about it would be about nothing you see.
 */
export function isActive(s: Session): boolean {
  if (!activeTab) return false;
  if (s === activeTab) return activeTab.view !== 'two';
  return s === activeTab.mate && activeTab.view !== 'one';
}

// Sessions just closed on this device; suppress a racing server sync from
// re-adding them before the kill is reflected server-side. Expired in sync().
export const recentlyClosed = new Map<string, number>();
export const CLOSE_GUARD_MS = 6000;
