# PROGRESS

This tracks the work on everything raised by the 2026-10-15 review: one
reviewer each for input, front end, server and README. The lead dispatches
each task to an `opus-implementer` in its own git worktree, reviews the diff and
the check results, and merges into `main` locally. Pushed and deployed on 2026-10-15
with the user's OK. `docs/ARCHITECTURE.md` holds the invariants every task
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

- 2026-10-15: Passkeys are added as an optional second way in through
  Cloudflare. The token is never switched off (the user declined a
  passkey-only mode). Each host registers its own passkeys (RP ID = request
  hostname). The cookie becomes a server-issued session id.

## Tasks

| ID | Scope | Depends on | Status |
|---|---|---|---|
| T1 | Server security: exact tmux targets, test socket, env scrub, cookie decode, fail-closed auth, Origin/Host check, name validation | – | done (ccda845) |
| T2 | Server resources: stream pipeline, streamed upload, WS backpressure, maxPayload, single-flight snapshots, collapse baseline, tailscale timeout, `/api/health` | T1 | done |
| T3 | Input, minimal: reconnect focus fix; key bar dropped while disconnected | – | done (cd935fa) |
| T4 | Front-end split, resize and lifecycle bugs | T3 | done (0ecf298) |
| T5 | Front-end touch, resources and cleanups | T4 | done |
| T6 | `service.sh` / `deploy.sh` hardening | – | done |
| T7 | README, `.env.example`, `web.tmux.conf` comment | T1–T6 | done |
| T8 | Split `web/terminal.ts` into modules | T5 | done |
| P1 | Passkey sign-in (optional, alongside the token), server-issued session cookies | D | in progress |
| D | Deploy to both boxes, rotate tokens, clear `AUTH_TOKEN` from tmux's global env | all, plus user OK | done (9a281ec) |

## Done

- T3 `cd935fa`: a reconnect re-focuses only when `activeSession === this` and focus is free (body or an xterm textarea); key-bar presses use `sendKey` and are dropped while disconnected, with a throttled 「未連線，按鍵沒有送出」; a paste over the 64 KB cap now shows a status instead of vanishing silently. Review: the diff touches no line of the frozen input path; tsc and build pass; one punctuation fix made at review.
- T4 `0ecf298`: background sizing skips 'both' tabs and sizes a 'two' tab's mate; restackSplit on a WIDE_PX flip; the resting height is held only on touch devices and re-taken on a width change; a mate's `closed` lays out only the open tab, through a shared `dropTab`; prefs save `activeTab.name`; the label is re-asserted only after this device's own restart; a pane flicked past doesn't attach; `isActive` matches what's visible; sync is gated on `tabsReady`; names are capped at 61; keyboard geometry is cached and the slide only grows. Review: sanitizeName is used only for user/URL names, so server-listed names aren't truncated; init has no early return that skips tabsReady. Accepted trade-off: rotating with the keyboard up resizes twice.
- T1 `ccda845`: every tmux call goes through the src/tmux.ts helpers (`-L` when `TERMINAL_WEB_TMUX_SOCKET` is set; snapshots off then); targets are exact; invalid names get a 400 or a 1008 close, never a fallback; the child env drops every config var plus TMUX/TMUX_PANE; cookie parsing and the upgrade handler can't throw; a Cloudflare request with no token configured gets 403; Host/Origin checks with `ALLOWED_HOSTS`; the debug log is escaped; login is a POST `/login`, and `?token=` redirects without the token. Lead's own smoke test on a scratch socket: 200/403/401/200/403 as expected, a same-origin WS opens and an evil one gets 403, typed input round-trips, the real tmux is unchanged. Deviation accepted: `set-option` needs `=name:` (ARCHITECTURE updated).
- T6: service.sh carries over HOST/PORT/token/PATH/extra env on reinstall; on Linux the token lives in a 0600 env file, on macOS the plist is written 0600; no silent 0.0.0.0 bind; the launchd bootstrap retries; logs over 10 MB rotate; deploy.sh runs `npm ci` when the lock changes (`.deploy/lock.sha`), typechecks before restarting, and checks the commit from /api/health afterwards; the wsl script reference is reworded. Simulated with a scratch HOME and stubs; the real plist was untouched. Deploy note: seed `.deploy/lock.sha` on both boxes before the first deploy so it doesn't run `npm ci` under the live server; run install with `env -u AUTH_TOKEN` (this shell has the leaked token).
- T5: long-press word selection works on wide characters (`wordRangeAt`); cells are measured from `.xterm-screen`, with handle offsets; `pressFired` is reset on touchcancel; top-bar buttons skip focus on touch devices (`refocusTerminal`); `#status` respects the safe area and sits at z 25; WebGL loads on first show; a single-timer heartbeat drops a socket after an unanswered ping (40 s, or 5 s after a wake), with a frozen-page guard; `wake()` runs on visibilitychange, pageshow and online; drawer dots update in place, with the idle class; dead copy/paste key branches removed; stale comments fixed; scrollback cut to 1000 (verified: tmux keeps xterm on the alternate screen); beforeunload removed. Review: the heartbeat counts any message as an answer, so busy output never trips it; dropSocket detaches the old handlers first; pendingSeq is flushed only by the new socket's onopen. The frozen input path was byte-identical (the agent checked it with a script).
- T2 `fa546c8` + `e4cc4c0`: static/download use `stream.pipeline`; uploads stream to a `wx` 0600 file, are size-checked on the fly and cleaned up on abort; WS backpressure pauses the pty above 1 MB buffered and resumes below 256 KB; snapshots are single-flight (a before-kill waits for a run that started after its request); the collapse guard subtracts deliberate kills; tailscale isn't probed when HOST is set (3 s timeout otherwise); `GET /api/health`; the `/api/sessions` list is cached for 1 s and invalidated on the user's own changes; tag writes are skipped when already tagged. Agent measurements: a 200 MB upload keeps RSS at about 104 MB; a paused client holds RSS at 100 MB (main grew to 588 MB); aborted downloads leak no fds. Lead decision: WS maxPayload is 16 MB, not 1 MB, because a paste is one frame with no client cap and the input path is frozen. Lead smoke test: health reports HEAD; upload OK; after a 2 MB frame the socket stays open and another session answers at once (the shell itself ingests a 2 MB single line slowly; that's expected).
- T8: the client is split into 16 modules (entry `web/terminal.ts`, `session.ts`, foundation `config/dom/state/status/overlays/clipboard/transfer/api/layout/ui/selbar`, app `tabs/ui/{topbar,keybar,mobile}`). Load-time side effects live in build/init functions called in the original order; shared state is written through setters; Session gets app hooks injected. Lead re-verification on merged main: the frozen input blocks are byte-identical (67 and 248 lines); the Session class differs only in `export` and one setter; a headless Chrome smoke run (load, attach, type `HI_42`, new tab, switch, split, narrow↔wide restack) passes with 0 exceptions; the real tmux is unchanged. ARCHITECTURE updated with the module map and the build-function rule.
- T7: README rewritten against the code (auth scope and the new 403/Host/Origin/login behaviour, security notes on download/upload, env table plus .env.example, key bar, copy/paste, keyboard slide, iframe postMessage contract, WS protocol, HTTP API table, install over HTTPS, pinned node-pty, service.sh/deploy.sh, closing tabs, split, lazy attach, reboot persistence, debug flags, Contributing); help text in overlays.ts; web.tmux.conf comments; `scripts/smoke/` (`npm run smoke`, plus `--screenshots`); screenshots regenerated (a generic prompt, nothing personal); demo.gif dropped from the README. Lead check: the screenshots are viewed and clean; README has no personal infra beyond the repo URL and the plist label the code uses. Personal tailnet IPs removed from ARCHITECTURE before publishing.

- D (2026-10-15): pushed 9a281ec; both boxes reinstalled through service.sh with fresh tokens (Mac plist now 0600; NUC token moved out of the unit into a 0600 env file, `KillMode=process` kept); `/api/health` reports 9a281ec on both; every tmux session survived (Mac 18, NUC 20); `AUTH_TOKEN` cleared from both tmux global envs. Through each Cloudflare hostname: no cookie 401, wrong token 401, right token 303 plus `tw_auth`, the old token 401, a cross-site POST 403, a same-origin WS opens and a cross-site one is refused. cloudflared keeps the Host header, so the Origin check doesn't break the tunnel. Snapshots save after the restart. Agent worktrees removed. The WSL box is the user's to deploy.

## Found during review

- Left for later (small): the help and paste-box copy still says "tap Copy / tap Paste"; the phone title-bar dot has no idle state; a socket stuck in CONNECTING after a wake waits for the browser's own timeout.

- `isolation: worktree` branches from `origin/main`, not local `main`. Each task prompt must start with `git merge --ff-only main`. T1 and T6 were dispatched before this was known, so they're based on e8b80cc and merged by cherry-pick.
