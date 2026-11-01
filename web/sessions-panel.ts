// The Sessions panel, opened from the ⋯ sheet: every tmux session on the
// server, tab or not, with what it is running and roughly how much memory it
// takes, so you can tell what is worth closing.
//
// A session that is not a tab (a tmux-resurrect restore brought it back bare,
// or it was opened from a shell) is otherwise invisible from the page. Here it
// can be opened as a tab (/api/sessions/adopt) or killed (/api/sessions/kill).
// The list comes from /api/sessions/inventory (src/inventory.ts).

import { activeSession } from './state.js';
import { flashStatus } from './status.js';
import { addSession, syncFromServer } from './tabs.js';

interface InventoryEntry {
  name: string;
  displayName: string;
  kind: 'tab' | 'hidden';
  mateOf?: string;
  attached: number;
  created: number;
  activity: number;
  command: string;
  rssKB: number | null;
}

/** One row of the panel: a session, with its second half folded in if it has one. */
interface Row {
  main: InventoryEntry;
  mate: InventoryEntry | null;
  /** Both halves together; null when either is unknown. */
  rssKB: number | null;
}

// The names the server acts on (see sessionName in src/tmux.ts). A session
// made from a shell can be called anything; one outside this can be listed but
// not opened or killed from here.
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MATE_SUFFIX = '__b';
/** How long to wait for a kill to land before showing the list anyway. */
const KILL_SETTLE_TRIES = 10;
const KILL_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** The inventory; `null` = tmux unreachable, `undefined` = the request failed. */
async function fetchInventory(): Promise<InventoryEntry[] | null | undefined> {
  try {
    const res = await fetch('/api/sessions/inventory', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { sessions?: unknown };
    if (data.sessions === null) return null;
    if (!Array.isArray(data.sessions)) return undefined;
    return data.sessions.filter(
      (e): e is InventoryEntry =>
        !!e && typeof e === 'object' && typeof (e as InventoryEntry).name === 'string',
    );
  } catch {
    return undefined;
  }
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, body: parsed };
  } catch {
    return { ok: false, body: null };
  }
}

function fmtMB(kb: number | null): string {
  if (kb === null) return '–';
  const mb = kb / 1024;
  if (mb < 1) return 'under 1 MB';
  return `about ${Math.round(mb)} MB`;
}

function fmtTotal(kb: number): string {
  const mb = kb / 1024;
  if (mb >= 1024) return `about ${(mb / 1024).toFixed(1)} GB`;
  return `about ${Math.round(mb)} MB`;
}

function fmtAgo(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Fold each second half into its first half's row; biggest first within each group. */
function toRows(entries: InventoryEntry[]): { tabs: Row[]; hidden: Row[] } {
  const mates = new Map<string, InventoryEntry>();
  for (const e of entries) if (e.mateOf) mates.set(e.mateOf, e);
  const rows: Row[] = [];
  for (const e of entries) {
    if (e.mateOf) continue;
    const mate = mates.get(e.name) ?? null;
    const rssKB =
      e.rssKB === null || (mate && mate.rssKB === null) ? null : e.rssKB + (mate?.rssKB ?? 0);
    rows.push({ main: e, mate, rssKB });
  }
  const bySize = (a: Row, b: Row): number => (b.rssKB ?? -1) - (a.rssKB ?? -1);
  return {
    tabs: rows.filter((r) => r.main.kind === 'tab').sort(bySize),
    hidden: rows.filter((r) => r.main.kind !== 'tab').sort(bySize),
  };
}

function button(text: string, cls = 'tb-btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
}

/**
 * Ask before killing a session that is not a tab, the way closing a tab asks
 * (confirmCloseSession). Resolves true to go ahead.
 */
function confirmKill(row: Row): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay confirm-overlay sp-confirm';
    const box = document.createElement('div');
    box.className = 'paste-box confirm-box';
    const label = document.createElement('div');
    label.className = 'paste-label';
    const strong = document.createElement('b');
    strong.textContent = row.main.name;
    const mateNote = row.mate ? ` and its split half "${row.mate.name}"` : '';
    label.append(
      'Kill the tmux session ',
      strong,
      `${mateNote}? This ends every program running in it, and can't be undone.`,
    );
    const btns = document.createElement('div');
    btns.className = 'paste-row';
    const cancel = button('Cancel');
    const ok = button('Kill', 'tb-btn danger');
    btns.append(cancel, ok);
    box.append(label, btns);
    overlay.append(box);
    document.body.append(overlay);
    window.setTimeout(() => ok.focus(), 0);

    let done = false;
    const finish = (yes: boolean): void => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(yes);
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
  });
}

export function openSessionsPanel(): void {
  if (document.querySelector('.sessions-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay sessions-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box help-box sessions-box';

  const title = document.createElement('div');
  title.className = 'help-title';
  title.textContent = 'Sessions and memory';
  const total = document.createElement('div');
  total.className = 'sp-total';
  const intro = document.createElement('div');
  intro.className = 'sp-note';
  intro.textContent =
    'Every tmux session on this server. Memory adds up each session\'s processes, so shared memory counts more than once.';
  const status = document.createElement('div');
  status.className = 'sp-status';
  status.setAttribute('role', 'status');
  const groups = document.createElement('div');
  groups.className = 'sp-groups';

  const row = document.createElement('div');
  row.className = 'paste-row';
  const refreshBtn = button('Refresh');
  const closeBtn = button('Close');
  row.append(refreshBtn, closeBtn);

  box.append(title, total, intro, status, groups, row);
  overlay.append(box);
  document.body.append(overlay);

  let open = true;
  let busy = false;
  const close = (): void => {
    open = false;
    overlay.remove();
    activeSession?.focus();
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  refreshBtn.addEventListener('click', () => void refresh());
  window.setTimeout(() => closeBtn.focus(), 0);

  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('sp-error', isError);
  };

  // --- actions ---------------------------------------------------------------
  const openAsTab = async (r: Row): Promise<void> => {
    const name = r.main.name;
    const res = await postJson('/api/sessions/adopt', { names: [name] });
    const adopted = Array.isArray(res.body?.adopted) ? (res.body.adopted as unknown[]) : [];
    if (!res.ok || !adopted.includes(name)) {
      say(`Could not open "${name}" as a tab.`, true);
      await refresh();
      return;
    }
    // The usual sync picks up tabs made elsewhere; this one is then opened. If
    // the tag has not landed yet the tab is made here (and opening it, which
    // attaches, tags it again).
    await syncFromServer();
    if (!open) return;
    close();
    addSession(name, true, r.main.displayName);
    flashStatus('已開成分頁', 1400);
  };

  const kill = async (r: Row): Promise<void> => {
    if (!(await confirmKill(r)) || !open) return;
    const name = r.main.name;
    say(`Killing "${name}"…`);
    const res = await postJson('/api/sessions/kill', { name });
    if (!res.ok) {
      say(String(res.body?.error ?? `Could not kill "${name}".`), true);
      await refresh();
      return;
    }
    // The server answers once its snapshot is saved and then kills, so the
    // first list after the answer may still have the session in it.
    await refresh(name);
    if (open) say(`Killed "${name}".`);
  };

  const act = (fn: () => Promise<void>): void => {
    if (busy) return;
    busy = true;
    for (const b of groups.querySelectorAll('button')) b.disabled = true;
    void fn().finally(() => {
      busy = false;
      for (const b of groups.querySelectorAll<HTMLButtonElement>('button')) {
        b.disabled = b.dataset.off === '1';
      }
    });
  };

  // --- list ------------------------------------------------------------------
  const renderRow = (r: Row): HTMLLIElement => {
    const e = r.main;
    const li = document.createElement('li');
    li.className = 'sp-item';
    li.dataset.session = e.name;
    const text = document.createElement('div');
    text.className = 'sp-text';
    const name = document.createElement('div');
    name.className = 'sp-item-name';
    name.textContent = e.displayName;
    if (e.displayName !== e.name) {
      const sub = document.createElement('span');
      sub.className = 'sp-sub';
      sub.textContent = ` (${e.name})`;
      name.append(sub);
    }
    const meta = document.createElement('div');
    meta.className = 'sp-meta';
    const activity = Math.max(e.activity, r.mate?.activity ?? 0);
    const attached = e.attached + (r.mate?.attached ?? 0);
    const bits = [
      e.command || '?',
      r.mate ? 'split' : '',
      activity ? `active ${fmtAgo(activity)}` : '',
      attached > 0 ? `${attached} attached` : '',
    ].filter(Boolean);
    meta.textContent = bits.join(' · ');
    text.append(name, meta);
    const mem = document.createElement('div');
    mem.className = 'sp-mem';
    mem.textContent = fmtMB(r.rssKB);
    if (r.mate) mem.title = `${fmtMB(e.rssKB)} + ${fmtMB(r.mate.rssKB)} (split)`;
    li.append(text, mem);

    if (e.kind === 'tab') {
      li.classList.add('sp-tab');
      li.tabIndex = 0;
      li.title = 'Switch to this tab';
      const go = (): void => {
        close();
        addSession(e.name, true, e.displayName);
      };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') go();
      });
      return li;
    }

    const actions = document.createElement('div');
    actions.className = 'sp-actions';
    const usable = NAME_RE.test(e.name);
    // A second half whose first half is gone: the server never adopts one as a
    // tab of its own, so it can only be killed.
    const orphanMate = e.name.endsWith(MATE_SUFFIX);
    if (!orphanMate) {
      const openBtn = button('Open as tab', 'tb-btn sp-open');
      if (!usable) {
        openBtn.disabled = true;
        openBtn.dataset.off = '1';
      }
      openBtn.addEventListener('click', () => act(() => openAsTab(r)));
      actions.append(openBtn);
    }
    const killBtn = button('Kill', 'tb-btn danger sp-kill');
    if (!usable) {
      killBtn.disabled = true;
      killBtn.dataset.off = '1';
    }
    killBtn.addEventListener('click', () => act(() => kill(r)));
    actions.append(killBtn);
    if (!usable) {
      actions.title = "This name can't be handled from here; use tmux directly.";
    }
    li.append(actions);
    return li;
  };

  const renderGroup = (heading: string, rows: Row[], empty: string): HTMLElement => {
    const section = document.createElement('section');
    section.className = 'sp-group';
    const h = document.createElement('div');
    h.className = 'sp-group-title';
    const sum = rows.reduce<number | null>(
      (acc, r) => (acc === null || r.rssKB === null ? acc : acc + r.rssKB),
      0,
    );
    h.textContent = rows.length ? `${heading} · ${rows.length} · ${sum === null ? '–' : fmtTotal(sum)}` : heading;
    const list = document.createElement('ul');
    list.className = 'sp-list';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'sp-empty';
      li.textContent = empty;
      list.append(li);
    }
    for (const r of rows) list.append(renderRow(r));
    section.append(h, list);
    return section;
  };

  const render = (entries: InventoryEntry[]): void => {
    const { tabs, hidden } = toRows(entries);
    const known = entries.filter((e) => e.rssKB !== null);
    const n = entries.length;
    const sessionsText = `${n} session${n === 1 ? '' : 's'}`;
    total.textContent = known.length
      ? `${fmtTotal(known.reduce((a, e) => a + (e.rssKB ?? 0), 0))} in ${sessionsText}` +
        (known.length < n ? ' (some unknown)' : '')
      : `Memory unknown · ${sessionsText}`;
    groups.replaceChildren(
      renderGroup('Tabs', tabs, 'No tabs.'),
      renderGroup('Not a tab', hidden, 'Every session is a tab.'),
    );
  };

  /** Load and show the list; with `gone`, keep asking for a moment until that session has left it. */
  const refresh = async (gone?: string): Promise<void> => {
    if (!groups.childElementCount) say('Loading…');
    let entries = await fetchInventory();
    for (let i = 0; gone && i < KILL_SETTLE_TRIES && Array.isArray(entries); i++) {
      if (!entries.some((e) => e.name === gone)) break;
      await sleep(KILL_SETTLE_MS);
      if (!open) return;
      entries = await fetchInventory();
    }
    if (!open) return;
    if (entries === undefined) {
      say('Could not load the session list.', true);
      return;
    }
    if (entries === null) {
      groups.replaceChildren();
      total.textContent = '';
      say('tmux is not reachable on the server.', true);
      return;
    }
    say('');
    render(entries);
  };
  void refresh();
}
