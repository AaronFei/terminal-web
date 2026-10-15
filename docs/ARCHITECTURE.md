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
| `src/auth.ts` | Shared-token gate for Cloudflare-fronted requests |
| `src/tmux.ts` | Every `tmux` invocation the server makes |
| `src/config.ts` | Env vars and defaults |
| `src/types.ts` | WebSocket control-message types |
| `web/terminal.ts` | The whole client (bundled by `esbuild.mjs` to `public/dist/`) |
| `public/` | `index.html`, `styles.css`, icons, manifest |
| `tmux/web.tmux.conf` | tmux config the server's sessions load |
| `scripts/` | `service.sh` (launchd/systemd), `deploy.sh`, `start.sh`, `dev.sh` |

## Deployments

- Mac: launchd `com.aaronfei.terminal-web`, bound to tailnet IP `100.81.231.8:8090`.
- NUC (Linux): `systemd --user` `terminal-web.service`, `KillMode=process` so tmux survives restarts, `100.84.185.98:8090`.
- Each box is also public through its own Cloudflare Tunnel.
- `tsx` does not hot-reload. A server change needs a restart on both boxes; a client-only change needs `npm run build`.

## Invariants

### Input path is frozen

The keyboard, IME and paste handling in `web/terminal.ts` covers the custom key
event handler, `wireInput`, the composition handlers, the iOS keyCode-229
rescue, the pre-edit drop and `IME_DEDUP_MS` in `onData`, and `send`. It was
tuned bug by bug against Windows Bopomofo, CapsLock IME switching and iOS CJK
keyboards. Do not restructure it, rename it or "simplify" it. A change there
needs a concrete bug, the smallest possible diff and the lead's sign-off.

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

Every `-t` naming a session uses `=name` (or `=name:` for a window or pane).
Without the `=`, tmux falls back to a unique-prefix match: killing `dev` after it
is already gone would kill `devops`.

### Never touch the user's live tmux server from a test

Claude Code on this Mac runs inside tmux, so `$TMUX` is set, and `$TMUX`
overrides `TMUX_TMPDIR`. Only an explicit socket isolates a test:
`env -u TMUX -u TMUX_PANE tmux -L <scratch> ...`. Before any kill, run
`list-sessions` with the exact same flags and confirm it shows only your test
sessions. A test server must run with `TERMINAL_WEB_TMUX_SOCKET=<scratch>`, an
env var added in task T1. Never run one before T1 has landed.

### Auth

- `AUTH_TOKEN` gates only Cloudflare-fronted requests, detected by the
  `cf-ray` / `cf-connecting-ip` headers. Tailnet access is open by design.
- A sign-in sets the HttpOnly + Secure cookie `tw_auth`.
- Secrets and server config must not leak into the child shell's environment.

### Snapshots before kills

tmux-resurrect saves a snapshot before every kill or restart, every 5 minutes,
and 90 s after start. tmux 3.4 crashed inside `kill-session`; the snapshot is
the recovery path.

### Closed tabs stay closed

`~/.terminal-web/closed.json` remembers closed names for 30 days. A connect
without `create=1` to a closed, absent name gets a `closed` reply, never a
recreated session.

### Pinned dependencies

`node-pty` stays at `1.2.0-beta.14`, which fixes the macOS fd leak. Do not
upgrade it.

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
