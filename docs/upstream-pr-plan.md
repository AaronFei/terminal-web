# Upstream split plan (no commits or publication performed)

Combined preparation branch: `feat/upstream-window-mode` in isolated worktree
`/home/liontree/terminal-web-upstream`, based on `2eb0e09e1eb7444d693cafad64e4e5c3f3ffcbf2`.
The deployed `feat/main-window-tabs` checkout is not the implementation target.
No new dependencies or package-lock changes are included.

## PR 1 — independent original-session IME/common input fixes

Purpose: fix defects already present in upstream's original session UI, without
requiring or advertising window tabs. The IME duplication/pre-edit bugs are
independent of the new window-view startup race.

Take these **hunks**, not the entire combined `web/terminal.ts`:

- `Session.imeKeyHandler` and the constructor custom keyboard hook that consults
  it for keydown **and keypress**.
- The event-owned `Session.wireInput()` rewrite: one 229 delivery record shared
  by rescue/keypress/input; compositionend owns commit and same-transaction
  trailing input; active/continued pre-edit guards; textarea paste cleanup;
  deliberate repeated characters, control bytes and native paste remain valid.
- `Session.send()` ignoring an empty cancelled-composition emission.
- Reusable socket lifecycle hunks in `Session.connect()`: OPEN/CONNECTING guard,
  local `socket` identity, and stale open/message/close callbacks ignored. Keep
  PR 1 comments generic. Do **not** take window-control frame handlers,
  `closeView()/resumeView()`, window payload logic or mode-specific URL changes.
  The duplicate-startup trigger itself belongs to PR 2; generic lifecycle
  robustness can ship in PR 1 without claiming it was an original IME defect.
  Leave the window boot's first-fit gate (`resumeView()` and its `!started`
  connect check) for PR 2; original session initialization already fits first.

Tests: extract the CDP/temporary-bundle/fake-WS harness and common keyboard cases
from `test/input.test.ts` into PR 1. Make its fixture initialize through the
original `/api/sessions` and `/api/prefs` flow, not `/api/windows`. Include
trusted repeated keys, special keys/autorepeat, 229 event orders/conversion,
composition cancellation/repeats/partial commits, paste/emoji, blur and
composition-preserving reconnect. The legacy fixture in the combined suite
already verifies representative common input in session mode; **the combined
file is not a standalone PR 1 patch** because it also contains window-only
startup/view/tab tests. Carry `package.json`'s existing-dependency-only `test`
script, and trim `docs/input-regressions.md` to PR 1's evidence/limitations.

Gate PR 1 on a fresh worktree based on upstream HEAD: typecheck, those
session-only Chromium/xterm tests, and a temporary frontend build. Do not infer
independent applicability merely from the combined branch passing tests.

## PR 2 — optional existing-session window tabs, based on PR 1

Preferred order: merge PR 1 first, then rebase/extract PR 2 on its result.
PR 2 depends on PR 1's input/lifecycle hunks; do not publish two branches based
on original HEAD that both edit them and call them independent.

PR 2 owns the remaining feature hunks/files:

- `src/config.ts`: default-off WINDOW_MODE, validated MAIN_SESSION and scratch
  socket/state configuration.
- `src/tmux.ts`: shared socket argv/environment helpers, attach-only arguments,
  window list/create/rename/select/kill, membership guard and pane-cwd lookup.
- `src/server.ts`: explicit mode/capabilities handshake, window endpoints and
  broadcasts, attach-only missing-session handling, isolated snapshot behavior,
  permitted explicit legacy session management, explicit window-mode restart,
  shared destructive-lifecycle ordering and exact session kill targets. The
  restart-recreation/later-kill race was introduced by explicit backend window
  restart; bare-name prefix matching in legacy HTTP/WS kill paths was inherited
  upstream behavior, hardened here alongside the touched feature lifecycle.
  Neither is classified as an IME defect.
- `src/types.ts`: absent/windows control frames and restart semantics docs.
- `web/terminal.ts`: optional-mode initialization/error/retry, window tabs and
  shared selection, view detach/resume with first-fit-before-attach gating,
  confirmed termination, operation
  mapping and window-only UI changes. Keep original session mode paths intact.
- `public/styles.css`, the tracked `public/index.html` change, `.env.example`,
  README and window docs. Never include generated/deployed `public/dist`.
- `test/windows.test.ts`, `test/legacy.test.ts`, `test/lifecycle.test.ts`
  (both-mode exact-target tests plus gated window-restart/later-kill race),
  and the remaining browser
  window/view/initialization/legacy-UI cases from `test/input.test.ts`.

Tests must retain all prior coverage with newly agreed semantics: no name-based
immunity, permitted explicit session APIs, allowed final-window termination,
no automatic missing-session recreation, both default and explicit off modes,
and original create/rename/kill/restart/split/init/reconnect behavior. Run the
full combined suite with an actual Chromium binary and unique scratch tmux
sockets. Actual Safari/iPad remains unverified.

If PR 2 must be submitted before PR 1 merges, either make it a stacked PR with
a clearly stated base/dependency, or include the common fixes and honestly
present one combined change. No commits, PRs, pushes or deployments have been
made by this preparation.
