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
| T1 | Server security: exact tmux targets, test socket, env scrub, cookie decode, fail-closed auth, Origin/Host check, name validation | – | todo |
| T2 | Server resources: stream pipeline, streamed upload, WS backpressure, maxPayload, single-flight snapshots, collapse baseline, tailscale timeout, `/api/health` | T1 | todo |
| T3 | Input, minimal: reconnect focus fix; key bar dropped while disconnected | – | todo |
| T4 | Front-end split, resize and lifecycle bugs | T3 | todo |
| T5 | Front-end touch, resources and cleanups | T4 | todo |
| T6 | `service.sh` / `deploy.sh` hardening | – | todo |
| T7 | README, `.env.example`, `web.tmux.conf` comment | T1–T6 | todo |
| T8 | Split `web/terminal.ts` into modules | T5 | todo |
| D | Deploy to both boxes, rotate tokens, clear `AUTH_TOKEN` from tmux's global env | all, plus user OK | todo |

## Done

## Found during review
