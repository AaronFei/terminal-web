# terminal-web architecture

A browser terminal: xterm.js in the page, a Node server (`tsx src/server.ts`)
that spawns one node-pty per tab running `tmux new-session -A`, so every tab is
a tmux session that outlives the page, the server and (via resurrect) a reboot.

This file is what implementation and review are checked against. Changing an
invariant below needs the lead's sign-off first, and then an update here.

## Layout

| Path | Role |
|---|---|
| `src/server.ts` | HTTP (static, upload, download, `/api/*`), WebSocket upgrade, pty lifecycle, snapshots |
| `src/auth.ts` | Sign-in gate for Cloudflare-fronted requests (login page, token, logout, the passkey HTTP endpoints), Host/Origin checks |
| `src/auth-store.ts` | Sign-in sessions and passkeys: in memory, persisted to `~/.terminal-web/{auth-sessions,passkeys}.json` |
| `src/passkeys.ts` | WebAuthn ceremonies (via `@simplewebauthn/server`) and their challenges |
| `src/tmux.ts` | Every `tmux` invocation the server makes |
| `src/tab-record.ts` | The tab record (`~/.terminal-web/tabs.json`): which sessions are web tabs, so a resurrect restore can be re-tagged |
| `src/inventory.ts` | `GET /api/sessions/inventory`: every tmux session, tab or not, with its memory |
| `src/config.ts` | Env vars and defaults |
| `src/types.ts` | WebSocket control-message types |
| `web/terminal.ts` | Client entry (bundled by `esbuild.mjs` to `public/dist/`): calls each module's `build*`/`init*` in a fixed order, then `init()` |
| `web/session.ts` | The `Session` class: one xterm + WebSocket per tmux session, including the frozen input path |
| `web/config.ts`, `dom.ts`, `state.ts`, `status.ts` | Constants and flags; the fixed DOM nodes; shared state (`sessions`, `activeTab`, `activeSession`, written only through their setters); the status toast |
| `web/layout.ts` | Pane sizing, split layout, keyboard slide, resize handling |
| `web/tabs.ts`, `api.ts` | Tab lifecycle and server sync; HTTP calls and prefs |
| `web/overlays.ts`, `clipboard.ts`, `transfer.ts` | Dialogs and the paste box; copy and paste; upload and download |
| `web/passkeys.ts` | The Passkeys panel (from help): list, add, delete, sign out |
| `web/sessions-panel.ts` | The Sessions panel (⋯ sheet): every session with its memory; hidden ones can be opened as a tab or killed |
| `web/ui/*.ts` | Top bar, key bar, selection bar, phone bar/drawer/sheet |
| `public/` | `index.html`, `styles.css`, icons, manifest |
| `tmux/web.tmux.conf` | tmux config the server's sessions load |
| `scripts/` | `service.sh` (launchd/systemd), `deploy.sh`, `start.sh`, `dev.sh` |

## Deployments

- macOS: a launchd user agent (installed by `scripts/service.sh`), bound to the machine's tailnet IP on :8090.
- Linux: `systemd --user` `terminal-web.service` with `KillMode=process`, so tmux survives restarts; also bound to the tailnet IP on :8090.
- Each box is also public through its own Cloudflare Tunnel.
- `tsx` does not hot-reload. A server change needs a restart on both boxes; a client-only change needs `npm run build`.

## Invariants

### Input path is frozen

The keyboard, IME and paste handling in `web/session.ts` covers the custom key
event handler, `wireInput`, the composition handlers, the iOS keyCode-229
rescue, the pre-edit drop and `IME_DEDUP_MS` in `onData`, and `send`. It was
tuned bug by bug against Windows Bopomofo, CapsLock IME switching and iOS CJK
keyboards. Do not restructure it, rename it or "simplify" it. A change there
needs a concrete bug, the smallest possible diff and the lead's sign-off.

### Client modules keep their load-time side effects in build functions

At load time a module only declares things, reads values (the URL,
localStorage, matchMedia) and creates detached DOM. Anything that touches the
page — attaching to the document, global listeners, timers, network calls —
lives in a `build*`/`init*` function, and `web/terminal.ts` calls those in a
fixed order. esbuild turns top-level `let`/`const` into `var`, so a module that
reads another module's binding too early gets a silent `undefined` instead of a
TDZ error. `Session` doesn't import the app layer: what it needs from there is
injected with `setSessionHooks`.

### The soft keyboard never resizes the pty

The terminal slides (`--kb-offset`) and keeps its resting height. A resize would
SIGWINCH tmux, and an alternate-screen program (Claude Code) loses the rows that
no longer fit. Avoid needless SIGWINCH in general: a size change should reach
the pty only when the visible pane really changed size.

### Split view is two sessions

A split tab shows session `X` and its mate `X__b`, each in its own pane, stacked
on narrow screens and side by side on wide ones. Views: `one`, `two`, `both`.
Closing a tab kills both halves.

### tmux targets are exact

Every `-t` naming a session goes through `sessionTarget()` (`=name`, for
`kill-session` and `has-session`) or `paneTarget()` (`=name:`, for
`display-message` and also `set-option`: tmux 3.6's `set-option -t` takes a
pane target, so `=name` fails with "no such session" there). Both live in
`src/tmux.ts`, and every tmux invocation goes through its helpers, which add
`-L <socket>` when `TERMINAL_WEB_TMUX_SOCKET` is set.
Without the `=`, tmux falls back to a unique-prefix match: killing `dev` after it
is already gone would kill `devops`.

### Never touch the user's live tmux server from a test

A developer's own shell (or Claude Code) often runs inside tmux, so `$TMUX` is set, and `$TMUX`
overrides `TMUX_TMPDIR`. Only an explicit socket isolates a test:
`env -u TMUX -u TMUX_PANE tmux -L <scratch> ...`. Before any kill, run
`list-sessions` with the exact same flags and confirm it shows only your test
sessions. A test server must run with `TERMINAL_WEB_TMUX_SOCKET=<scratch>`, an
env var added in task T1, and must also run with `HOME=<scratch dir>`, on
`HOST=127.0.0.1` and a port other than 8090. Never run one before T1 has
landed. The scratch `HOME` is required because the server keeps
`~/.terminal-web/{closed,prefs}.json`, uploads to `~/terminal-web-uploads`, and
reads resurrect snapshots from `~/.local/share/tmux/resurrect`. On top of that,
`tmux/web.tmux.conf` loads tmux-continuum with auto-restore, so with the real
`HOME` a brand-new scratch tmux server would restore the user's real sessions
into itself, Claude processes included. Only kill test processes you started,
by PID; never `pkill node` or `pkill tsx`, because the production servers run
under the same user.

### Auth

- `AUTH_TOKEN` gates only Cloudflare-fronted requests, detected by the
  `cf-ray` / `cf-connecting-ip` headers. Tailnet access is open by design.
- Two ways to sign in through Cloudflare: the shared token (always available,
  never switched off) or a passkey (WebAuthn). Passkeys are optional extras;
  with none registered everything works with the token alone.
- A sign-in sets the HttpOnly cookie `tw_auth` (Secure behind https). Its value
  is a random server-issued session id, never the token itself. The server
  keeps only a SHA-256 of each id, in `~/.terminal-web/auth-sessions.json`
  (0600), with how it was made: `token` (plus a fingerprint of the token in
  force) or `passkey` (plus the credential id). A token session dies when
  `AUTH_TOKEN` changes; a passkey session dies when its passkey is deleted. A
  legacy cookie whose value equals the current token is still accepted.
- Passkeys are per host: the RP ID is the hostname of the request, never
  hard-coded, so Mac and NUC each register their own. They live in
  `~/.terminal-web/passkeys.json` (0600) with the RP ID they belong to.
  Ceremonies run only on Cloudflare-fronted requests (the browser needs https
  and a domain; a tailnet IP can't hold a passkey). Registering needs a signed-in
  session. Listing and deleting also work over the tailnet, which is the
  recovery path, as is deleting `passkeys.json`.
- Challenges are random, single-use, bound to their RP ID and expire after
  5 minutes. Verification is done by `@simplewebauthn/server`.
- Secrets and server config must not leak into the child shell's environment.

### Snapshots before kills

tmux-resurrect saves a snapshot before every kill or restart, every 5 minutes,
and 90 s after start. tmux 3.4 crashed inside `kill-session`; the snapshot is
the recovery path.

### Closed tabs stay closed

`~/.terminal-web/closed.json` remembers closed names for 30 days. A connect
without `create=1` to a closed, absent name gets a `closed` reply, never a
recreated session.

### Tab membership survives a restore

tmux is the source of truth for which sessions are tabs (`@twtab`, label in
`@twlabel`), but tmux-resurrect restores sessions without user options. Before
2026-11 a restored session became a tab again only if some device still had it
cached and sent `/api/sessions/adopt`; the rest kept running, invisible and
unkillable from the page (found on 2026-11-01: 8 of them, ~800 MB).

`src/tab-record.ts` keeps `~/.terminal-web/tabs.json`:
`{ "version": 2, "tabs": [ { "name": "<name>", "label": "<display name>", "lastSeen": <ms epoch> } ] }`.
The array order is the tab order (see "The server owns the tab list and its
order"). A version 1 file (`"tabs": { "<name>": {...} }`) is still read, in
its key order, and is written back as version 2 at startup. A server older than this
reads a version 2 file as empty; that only loses the order and the labels of
restored tabs, so a rollback is safe.

- A name is added (or its label updated) whenever the server tags a session:
  a connect, an adopt, a rename, a re-tag. Every tagged session seen in a tab
  list from tmux is added too (with its tmux label), because most tabs are
  never connected between a deploy and the next reboot. Second halves (`__b`)
  are never in it.
- A tagged session that shows no label of its own (displayName = name) while
  the record holds a different one lost it the same way (a connect or adopt
  tagged it before any list ran), so the recorded label is written back. A
  rename that lands while a list is in flight (`labelEpoch`) keeps that list
  from syncing labels either way.
- A name is removed only when this server kills it as a closed tab
  (`/api/sessions/kill`), or when it has not been seen alive in tmux for 30
  days. A tmux server dying removes nothing, so a restore after a crash still
  finds every name.
- Whenever the tab list is fetched from tmux, any session that exists, carries
  no `@twtab`, is not a second half, is not in `closed.json`, and is in the
  record gets tagged again with its recorded label, and is in that same list.
- Written like `closed.json`: temp file + rename, 0600, debounced; a corrupt or
  missing file reads as empty and is never fatal.

The record only ever adds tags to sessions that exist. It never creates or kills
a session, and the tab list is still read from tmux.

Re-tagging is the server's job only. Since 2026-11 the page no longer sends
`/api/sessions/adopt` for tabs it remembers (it used to, at init and before
every sweep): with the record doing it, a page's stale cache could only pull
back sessions that are not tabs any more, so a page that had been open for days
merged its old tab set into everyone's. `/api/sessions/adopt` stays for the
Sessions panel's "Open as tab", which is an explicit user action.

### The server owns the tab list and its order

Which tabs there are, their labels and their order all come from
`GET /api/sessions`. Response:

```
{ "tabs": [ { "name": "work", "displayName": "work" }, ... ] | null,   // null: tmux unreachable
  "build": "<asset stamp>" }                                           // "" when not built
```

- Order: the tab record's order. A name new to the record is appended, so a
  new tab goes last on every device. A rename, a re-tag or a restore keeps its
  place. A name the record does not hold yet (a live socket whose tag has not
  landed) comes after the recorded ones, in the order tmux lists it.
- A page's sync makes its strip equal to that list: it adds what is missing,
  drops what the list does not have, takes the server's labels and reorders
  its tabs (`sessions` and the DOM) to the server's order. The only exceptions
  are the existing guards: a tab built on this page in the last
  `CREATE_GUARD_MS` that the list does not show yet stays (at the end), and a
  tab closed on this page in the last `CLOSE_GUARD_MS` is not re-added. The
  open tab is per device and changes only if its tab went away.
- At init, a list that came back is used even when it is empty (then the
  fallback tab `web` is made, never a cached name). The per-device cache
  (`tw.tabs`) stands in for the list only when the server could not be
  reached; otherwise it only supplies each listed tab's split view and this
  device's last open tab. Labels always come from the server.
- Every fetch on the init and sync path (tab list, prefs, rename) has a
  timeout (`fetchWithTimeout` in `web/api.ts`), and a sync that is somehow still
  marked running after `SYNC_STUCK_MS` (15 s) no longer blocks the next one.
  Before this, one hung request left a page that never synced again.

### Pages follow the build

`build` in `/api/sessions` is `assetVersion()`, the same stamp `index.html`
puts on `/dist/terminal.js?v=`. The page reads its own stamp from that script
tag. When both are non-empty and differ, the page is running a client older
than the server's and reloads itself: at once if it is hidden, otherwise the
next time it is hidden, or after 2 minutes with no key, pointer or touch input
while visible, with a status message saying so. A page reloads at most once
per server build (remembered in `sessionStorage`), so a mismatch that a reload
does not fix (a proxy serving an old bundle) never loops. tmux holds the
sessions, so a reload costs only a re-attach. Clients from before this cannot
reload themselves; each needs one manual reload.

### Every session is visible somewhere

The Sessions panel (⋯ sheet → Sessions and memory) lists every tmux session on
the server's socket, from `GET /api/sessions/inventory`. Response:

```
{ "sessions": null }                       // tmux unreachable
{ "sessions": [ {
    "name": "work",
    "displayName": "work",                 // label for tabs, else the name
    "kind": "tab" | "hidden",              // "tab" = what /api/sessions lists
    "mateOf": "work",                      // only on X__b whose X exists; kind follows X
    "attached": 1,                         // tmux clients attached
    "created": 1761800000,                 // unix seconds
    "activity": 1761900000,                // unix seconds, last output
    "command": "claude",                   // current command of the first pane
    "rssKB": 351232 | null                 // RSS of every pane process and all its descendants; null if ps failed
} ] }
```

`kind` is exactly what `/api/sessions` lists (both come from `currentWebTabs()`
in server.ts: tagged, or a live socket; a second half is folded into its first
half and never tagged by the server). So a second half `X__b` whose `X` exists
carries `mateOf` and X's kind, unless `/api/sessions` itself lists `X__b` (it
is tagged or connected while X is not a tab): then it is `tab` with no
`mateOf`. An `X__b` with no `X` is normally `hidden` and offers only Kill
(adopt skips second halves). A name outside `[A-Za-z0-9_-]{1,64}` (made from a
shell) is listed with both buttons disabled, since adopt and kill refuse it. A hidden session offers "Open as
tab" (`/api/sessions/adopt`) and "Kill" (`/api/sessions/kill`, after a confirm;
it kills the mate too, and goes through the usual snapshot first). Memory is a
sum of RSS, so shared pages are counted more than once; the panel says "about".

### Pinned dependencies

`node-pty` stays at `1.2.0-beta.14`, which fixes the macOS fd leak. Do not
upgrade it.

### Client URLs are relative

Every URL the client builds — `fetch`, upload, download, the WebSocket, and the
links in `index.html` and the manifest — is relative to the page's directory
(`basePath` in `web/config.ts`), never to the host root. Served at `/` this is
the same as before; it also lets a reverse proxy mount the app under a sub-path
(e.g. `/term/`) with the prefix stripped, with no server change. Don't add a
leading-slash URL on the client.

### Instances are fully separate

`TERMINAL_WEB_INSTANCE=<name>` runs a second server that must never see the
main one's sessions. Tab membership lives on the tmux sessions themselves
(`@twtab`), so separate state files alone would not be enough: an instance
gets its own tmux server (`-L tw-<name>`), and everything per-server lives
under `~/.terminal-web/instances/<name>/` (`state-dir.ts`; uploads default to
`uploads/` there). Its tmux server starts from a generated `tmux.conf` that sets
`@resurrect-dir` to the instance's own directory before sourcing
`web.tmux.conf`: otherwise tmux-continuum's auto-restore on a fresh server
would restore the main instance's last snapshot into it. Snapshots are off for
an instance (resurrect's save script would run against the default server).
Every new per-server file must go under `stateDir()`, never `~/.terminal-web`
directly.

### Asset cache-busting

Every asset that `index.html` links to carries a `?v=` build stamp. Cloudflare
rewrites `no-cache` to a 4-hour max-age, so an asset without the stamp is served
stale.

## Checks

There is no automated test suite. Every change must pass:

- `npx tsc --noEmit -p .`
- `npm run build`

Put `/opt/homebrew/bin` on `PATH` first. Behaviour checks are done by hand, or
with headless Chrome against a server on a scratch tmux socket (see the test
invariant above).
