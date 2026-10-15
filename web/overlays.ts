// Overlays: the paste box, help, and the in-page prompt.

import { isMac } from './config.js';
import { activeSession } from './state.js';

// A small overlay with a real <textarea> the user pastes into, then we forward
// the text to the active session. Works without the Clipboard API (HTTP/iPad).
export function openPasteBox(): void {
  if (document.querySelector('.paste-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box';
  const label = document.createElement('div');
  label.className = 'paste-label';
  label.textContent = `Paste here (${isMac ? '⌘V' : 'Ctrl+V'} / long-press → Paste) — sends automatically`;
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
    if (t) activeSession?.pasteText(t);
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
// button and the ⋯ sheet's Help row.
export function openHelp(): void {
  if (document.querySelector('.help-overlay')) return;
  const selKey = isMac ? '⌥ Option' : 'Shift';
  const pasteKey = isMac ? '⌘V' : 'Ctrl+V';
  const copyKey = isMac ? '⌘C' : 'Ctrl+Shift+C';
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay help-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box help-box';
  box.innerHTML =
    '<div class="help-title">How to copy / paste / files</div>' +
    '<ul class="help-list">' +
    `<li><b>Copy</b> — hold <b>${selKey}</b> and drag to select; it copies automatically. (Or select, then <b>${copyKey}</b> / tap <b>Copy</b>.)</li>` +
    `<li><b>Paste</b> — click the terminal, then <b>${pasteKey}</b>${
      isMac ? '' : ' (or Ctrl+Shift+V)'
    }. On a phone/tablet, tap <b>Paste</b> and paste into the box that appears.</li>` +
    (isMac
      ? ''
      : '<li><b>Literal ^V</b> (vim visual-block, readline quoted-insert) — Ctrl+V now pastes, so press <b>Ctrl+Q</b>, which both accept as its alias.</li>') +
    '<li><b>Attach a file</b> (for Claude Code etc.) — tap the 📎 button, or paste / drag any file (image, PDF, text…): it uploads and inserts the file path. Then press Enter.</li>' +
    '<li><b>Download a file</b> — tap the ⬇ button (or <b>⋯ → Download</b> on a phone) and enter a name/relative path from the terminal\'s current folder (e.g. <code>report.zip</code>), or a full path (<code>~/output/report.zip</code>). It downloads to this device.</li>' +
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
}

// PWA-safe replacement for window.prompt(). iOS standalone WebViews (display:
// standalone — see manifest) suppress or hang on the native prompt/alert/confirm
// dialogs, which froze the whole UI when "+ New session" / rename were tapped.
// Render our own overlay instead (same pattern as confirmCloseSession). Resolves
// to the entered text, or null if cancelled/dismissed.
export function domPrompt(opts: {
  label: string;
  value?: string;
  okText?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    if (document.querySelector('.prompt-overlay')) {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay prompt-overlay';
    const box = document.createElement('div');
    box.className = 'paste-box prompt-box';
    const label = document.createElement('div');
    label.className = 'paste-label';
    label.textContent = opts.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.value = opts.value ?? '';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const row = document.createElement('div');
    row.className = 'paste-row';
    const cancel = document.createElement('button');
    cancel.className = 'tb-btn';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'tb-btn';
    ok.type = 'button';
    ok.textContent = opts.okText ?? 'OK';
    row.append(cancel, ok);
    box.append(label, input, row);
    overlay.append(box);
    document.body.append(overlay);
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    let done = false;
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      overlay.remove();
      activeSession?.focus();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input.value));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
  });
}
