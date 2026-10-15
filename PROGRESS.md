# PROGRESS

This tracks the work on everything raised by the 2026-10-15 review: one
reviewer each for input, front end, server and README. The lead dispatches
each task to an `opus-implementer` in its own git worktree, reviews the diff and
the check results, and merges into `main` locally. Nothing is pushed or deployed
until the user agrees. `docs/ARCHITECTURE.md` holds the invariants every task
must keep.

## Decisions

- 2026-10-15: The input path stays frozen. Only two input changes go in: the
  reconnect focus fix and dropping key-bar presses while disconnected. The
  user chose to drop them rather than queue them.
- 2026-10-15: Uploaded-file paths and pastes are still queued while
  disconnected; only key-bar presses are dropped.
- 2026-10-15: T1 adds `TERMINAL_WEB_TMUX_SOCKET`, which runs every tmux call
  on a `-L` socket and turns snapshots off. It exists so later tasks can test a
  real server safely.
- 2026-10-15: `GET /api/health` returns `{ ok, commit, startedAt }`. T2 adds it;
  T6's deploy.sh uses it and falls back when it is missing.
- 2026-10-15: The module split (T8) waits until T3–T5 are merged.
- 2026-10-15: The token is rotated at deploy time, on both boxes, after T1.

## Tasks

| ID | Scope | Depends on | Status |
|---|---|---|---|
| T1 | Server security: exact tmux targets, test socket, env scrub, cookie decode, fail-closed auth, Origin/Host check, name validation | – | done (ccda845) |
| T2 | Server resources: stream pipeline, streamed upload, WS backpressure, maxPayload, single-flight snapshots, collapse baseline, tailscale timeout, `/api/health` | T1 | in progress |
| T3 | Input, minimal: reconnect focus fix; key bar dropped while disconnected | – | done (cd935fa) |
| T4 | Front-end split, resize and lifecycle bugs | T3 | done (0ecf298) |
| T5 | Front-end touch, resources and cleanups | T4 | in progress |
| T6 | `service.sh` / `deploy.sh` hardening | – | in progress |
| T7 | README, `.env.example`, `web.tmux.conf` comment | T1–T6 | todo |
| T8 | Split `web/terminal.ts` into modules | T5 | todo |
| D | Deploy to both boxes, rotate tokens, clear `AUTH_TOKEN` from tmux's global env | all, plus user OK | todo |

## Done

- T3 `cd935fa`: a reconnect re-focuses only when `activeSession === this` and focus is free (body or an xterm textarea); key-bar presses use `sendKey` and are dropped while disconnected, with a throttled 「未連線，按鍵沒有送出」; a paste over the 64 KB cap now shows a status instead of vanishing silently. Review: the diff touches no line of the frozen input path; tsc and build pass; one punctuation fix made at review.
- T4 `0ecf298`: background sizing skips 'both' tabs and sizes a 'two' tab's mate; restackSplit on a WIDE_PX flip; the resting height is held only on touch devices and re-taken on a width change; a mate's `closed` lays out only the open tab, through a shared `dropTab`; prefs save `activeTab.name`; the label is re-asserted only after this device's own restart; a pane flicked past doesn't attach; `isActive` matches what's visible; sync is gated on `tabsReady`; names are capped at 61; keyboard geometry is cached and the slide only grows. Review: sanitizeName is used only for user/URL names, so server-listed names aren't truncated; init has no early return that skips tabsReady. Accepted trade-off: rotating with the keyboard up resizes twice.
- T1 `ccda845`: every tmux call goes through the src/tmux.ts helpers (`-L` when `TERMINAL_WEB_TMUX_SOCKET` is set; snapshots off then); targets are exact; invalid names get a 400 or a 1008 close, never a fallback; the child env drops every config var plus TMUX/TMUX_PANE; cookie parsing and the upgrade handler can't throw; a Cloudflare request with no token configured gets 403; Host/Origin checks with `ALLOWED_HOSTS`; the debug log is escaped; login is a POST `/login`, and `?token=` redirects without the token. Lead's own smoke test on a scratch socket: 200/403/401/200/403 as expected, a same-origin WS opens and an evil one gets 403, typed input round-trips, the real tmux is unchanged. Deviation accepted: `set-option` needs `=name:` (ARCHITECTURE updated).

## Found during review

- To check at deploy: whether cloudflared keeps the original Host header (the default). If it rewrites it, the Origin check returns 403 for WS and POST through the tunnel.

- `isolation: worktree` branches from `origin/main`, not local `main`. Each task prompt must start with `git merge --ff-only main`. T1 and T6 were dispatched before this was known, so they're based on e8b80cc and merged by cherry-pick.
