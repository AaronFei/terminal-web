// Pages follow the build: a page running an older client than the server's
// reloads itself (see docs/ARCHITECTURE.md, "Pages follow the build").
//
// The page's own stamp is the ?v= the server put on the bundle's <script> tag;
// the server's comes with every /api/sessions answer (api.ts hands it to
// noteServerBuild). Both non-empty and different: reload at once if the page is
// hidden, else the next time it is hidden or once it has gone 2 minutes
// without a key, pointer or touch. At most once per server build, remembered
// in sessionStorage, so a reload that does not fix the mismatch never loops.

import { flashStatus } from './status.js';

const IDLE_RELOAD_MS = 2 * 60 * 1000;
const RELOADED_KEY = 'tw.reloadedForBuild';

// Read once, at load: the stamp of the bundle that is running. '' (no ?v=, as
// on an unbuilt or dev page) means never compare.
const ownBuild = ((): string => {
  try {
    const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/dist/terminal.js"]');
    if (!el) return '';
    return new URL(el.src, location.href).searchParams.get('v') ?? '';
  } catch {
    return '';
  }
})();

let started = false;
// The newer server build this page should reload for, or ''.
let pendingBuild = '';
let notifiedFor = '';
let lastInput = 0;
let idleTimer = 0;

function reloadedFor(): string {
  try {
    return sessionStorage.getItem(RELOADED_KEY) ?? '';
  } catch {
    return '';
  }
}

function reloadNow(): void {
  const build = pendingBuild;
  if (!build) return;
  pendingBuild = '';
  window.clearTimeout(idleTimer);
  idleTimer = 0;
  // Only reload once the "done it for this build" mark is really stored: with
  // no storage to remember it in, a mismatch a reload does not cure would loop.
  try {
    sessionStorage.setItem(RELOADED_KEY, build);
  } catch {
    /* fall through to the read-back */
  }
  if (reloadedFor() !== build) return;
  location.reload();
}

function armIdle(): void {
  if (idleTimer || !pendingBuild) return;
  const wait = Math.max(0, lastInput + IDLE_RELOAD_MS - performance.now());
  idleTimer = window.setTimeout(() => {
    idleTimer = 0;
    if (!pendingBuild) return;
    if (document.visibilityState === 'hidden' || performance.now() - lastInput >= IDLE_RELOAD_MS) {
      reloadNow();
    } else {
      armIdle(); // there was input meanwhile: wait out the rest from it
    }
  }, wait);
}

function act(): void {
  if (!started || !pendingBuild) return;
  if (document.visibilityState === 'hidden') {
    reloadNow();
    return;
  }
  if (notifiedFor !== pendingBuild) {
    notifiedFor = pendingBuild;
    flashStatus('New version: reloading when this page is hidden or idle for 2 minutes', 10000);
  }
  armIdle();
}

/** What the server says its build is (the `build` field of /api/sessions). */
export function noteServerBuild(build: string): void {
  if (!ownBuild || !build || build === ownBuild || build === reloadedFor()) {
    // Same build (again), unknown, or one this tab already reloaded for once.
    pendingBuild = '';
    window.clearTimeout(idleTimer);
    idleTimer = 0;
    return;
  }
  pendingBuild = build;
  act();
}

export function initVersionCheck(): void {
  started = true;
  lastInput = performance.now();
  const onInput = (): void => {
    lastInput = performance.now();
  };
  for (const type of ['keydown', 'pointerdown', 'touchstart']) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingBuild) reloadNow();
  });
  act(); // a stamp that arrived before this
}
