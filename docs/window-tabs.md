# Optional existing-session window tabs

The default remains original **session tabs**: `WINDOW_MODE` unset or `0`.
Set `WINDOW_MODE=1` explicitly to use windows of an **existing** tmux session
as browser tabs. `MAIN_SESSION` names the target (default `main`, validated
as `[A-Za-z0-9_-]{1,64}`). This is generic tmux functionality, not iTerm2-specific.
Window mutations resolve `=session:@id` in that target's context, including
linked windows, with same-command identity checks to reject unlink fallback.

```bash
tmux new-session -d -s main      # or use a session you already have
WINDOW_MODE=1 MAIN_SESSION=main npm start
```

The client first fetches `GET /api/windows`. Its explicit `mode` and
`capabilities.windowTabs/sessionTabs` choose the UI before any terminal attaches.
A failed/invalid configuration response leaves an initialization error and an
explicit retry button, not a guessed window/session mode. In session mode the
original create, rename-label, kill, restart, split, adoption, cached init and
reconnect paths remain available.

## What a window tab is

| Property | Source/operation |
|---|---|
| Identity | tmux `#{window_id}` (`@12`), stable for the window lifetime; index is only ordering |
| Label | Actual tmux window name; rename runs `rename-window` |
| Active tab | Authoritative `#{window_active}` in the configured session; every ordinary client attached there shares this selection |
| New tab | `new-window -t <target>`, which also selects the new window |
| List | `list-windows` on the configured target; external changes appear without reload |

One xterm and one WS/PTY attach render the **whole tmux window**, including any
panes tmux draws. Tabs reuse that view rather than opening additional ptys.
Attachment uses ordinary `attach-session`, never `new-session -A`. A missing
session is shown as absent; neither browser initialization nor reconnect creates
it. If it is created externally later, the view can attach to the new existing
session. Missing windows are not recreated from remembered tabs.

## Shared current window and size

Every browser shares the target session's current window. Selecting a tab
changes it for every ordinary attached client. There is no private per-browser
selection, no grouped sessions, no control-mode backend, and no per-pane UI.

Window size is shared as well. Ordinary attach does not load `-f`, so this
feature does not apply `tmux/web.tmux.conf` or its `window-size latest` setting
to the existing server. Size follows that server's own policy; a resize can
still affect every attached client. Grouped sessions would not isolate window
or pane size either and are not used here. Window switching redraws the same
xterm; its local scrollback is not independent history for each window.

## Close view versus Terminate

| Action | Effect |
|---|---|
| **Close view** or close browser | Detach only this browser's tmux client; no window/session is killed |
| **Terminate** | Confirmation warns about programs and final-window session termination; POST `/api/windows/kill` requires `confirm: true` and target membership, then kills that window |

Terminating the **final window is allowed** and ends the session. If it was the
server's only session, tmux itself exits. The page shows the target as absent
and does not recreate it through automatic view reconnect.

`MAIN_SESSION` is a target, **not a protected session**. The window UI does not
show session restart/split controls, since those operate on sessions rather
than window tabs. This is not an API ban: explicit `/api/sessions/rename`,
`/adopt`, `/kill` remain available in either mode. The legacy kill endpoint
keeps its existing pair semantics (named session plus its `__b` mate).

An explicit WS `{ "type": "restart" }` still restarts its attached target.
In original session mode, reconnect performs the legacy recreation. In window
mode the backend deliberately kills and recreates the target as part of that
explicit operation; subsequent view connections are still attach-only. This is
not an automatic missing-session recovery. As with tmux CLI commands, users are
responsible for the explicitly requested operation and its consequences.

Server-issued session kill/restart and window termination requests share an
ordered lifecycle queue. A later explicit session kill waits for an earlier
restart's recreation and then kills it; session kill replies only after its
exact base/mate kill commands finish. Session names are matched exactly (not
by tmux name prefixes). Explicit session management remains permitted in both
modes; this adds neither name immunity nor final-window protection.

## Isolation and testing

All tmux calls/PTY argv share the socket prefix (`-u`, plus `-L <name>` when
`TMUX_SOCKET_NAME` is set). Empty means tmux's default socket. Tests use only
unique named scratch sockets, non-production sessions, loopback ephemeral
ports, and temporary state/upload directories. They do not inspect or mutate
production `main`, restart services, or rebuild deployed `public/dist`.

`TERMINAL_WEB_STATE_DIR` redirects prefs/closed-tab files. Snapshot saving is
skipped on non-default sockets because tmux-resurrect's script uses the default
socket. Invalid configured socket names fail rather than falling back.

`npm test` includes real Chromium/xterm event tests and real WS/PTY/tmux window
and legacy lifecycle tests. Client bundles for browser tests are built into
OS temporary directories. See [input-regressions.md](input-regressions.md).

**Not verified:** actual Safari/iPhone/iPad keyboard behavior, real Windows
Bopomofo/macOS IME-switching hardware, and native on-device reconnects.
Chromium native IME plus synthetic event traces are not Safari verification.

Preparation evidence: [upstream-validation.md](upstream-validation.md).
Proposed upstream boundaries: [upstream-pr-plan.md](upstream-pr-plan.md).
