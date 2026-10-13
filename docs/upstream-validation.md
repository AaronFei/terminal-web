# Isolated upstream preparation validation

## Delivered tree

- Worktree: `/home/liontree/terminal-web-upstream`
- Branch: `feat/upstream-window-mode`
- Base HEAD: `2eb0e09e1eb7444d693cafad64e4e5c3f3ffcbf2`
- Changes remain uncommitted; no PR, push or deployment was performed.
- Dependencies: ignored local `node_modules/` directory containing symlinks to
  the existing deployed checkout's package directories and `.bin`; no install
  or dependency/lockfile update was run.
- The pre-existing original `package-lock.json` diff was excluded from transfer.

## Exact validation commands and results

Run from `/home/liontree/terminal-web-upstream`:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --skipLibCheck --strict \
  --noUnusedLocals --noUnusedParameters test/*.test.ts
git diff --check
CHROMIUM_BIN=/home/liontree/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm test
```

Results: both typechecks and tracked diff whitespace check passed (exit 0).
Final post-review suite: **65 tests, 8 suites, 65 passed, 0 failed/cancelled/skipped**,
about 22.6 seconds on this host. Existing coverage was adapted rather than deleted.
The final test log is `/tmp/terminal-web-upstream-startup-tests.log`.
Earlier runs remain in `/tmp/terminal-web-upstream-tests.log` (57 tests),
`/tmp/terminal-web-upstream-linked-tests.log` (59), and
`/tmp/terminal-web-upstream-lifecycle-tests.log` (64). New docs/tests were
also checked for trailing whitespace. The Pi managed test window initially
lacked npm in its PATH; the run was corrected by exporting
`/home/liontree/.nvm/versions/node/v24.11.1/bin` before npm. That environment
startup failure was not counted as a test pass.

Independent temporary frontend build (not `npm run build`, which would target
`public/dist`):

```bash
build_dir=$(mktemp -d /tmp/terminal-web-upstream-build-XXXXXX)
BUILD_DIR="$build_dir" node --input-type=module -e '
  import {build} from "esbuild";
  await build({entryPoints:["web/terminal.ts"], bundle:true, format:"esm",
    platform:"browser", sourcemap:true, outdir:process.env.BUILD_DIR,
    logLevel:"info"});
  console.log("TEMP_BUILD=" + process.env.BUILD_DIR);
'
```

Final post-review build passed in 79 ms. Actual output directory:
`/tmp/terminal-web-upstream-build-8qnLyH`.

| Artifact | Bytes |
|---|---:|
| `terminal.js` | 670255 |
| `terminal.css` | 4861 |
| `terminal.js.map` | 1867671 |
| `terminal.css.map` | 7944 |

The browser tests independently build their own current-source bundle into
OS temporary directories and clean those fixtures afterward.

## Coverage and limits

- Default/unset and explicit-off legacy modes: create/init, label rename/adopt,
  kill plus split mate/tombstones, configured-target restart with no name
  immunity, split cwd, resume/reconnect.
- Window mode: stable ids and shared selection, create/rename/select/external
  changes, session-scoped linked-window selection, same-command identity guards
  against external-unlink/current-window fallback, literal rename parsing and
  direct tmux rename semantics, membership/input validation, explicit legacy session APIs and target
  restart/kill, deterministic restart-recreation/later-session-kill ordering,
  exact session/base+mate targeting (prefix keepers survive missing targets),
  permitted final-window termination (including no-server state),
  missing-session attach refuses creation.
- Real Chromium/xterm: trusted repeated/special keys/autorepeat, native IME,
  synthetic 229/composition traces, paste/emoji, composition reconnect, stale
  callbacks, one startup socket with measured initial query dimensions
  (default and wide viewport), legacy UI operation mapping, initialization
  fetch error/explicit retry.
- Real browser -> WS -> PTY -> tmux: exact raw stdin bytes in two recorders,
  correct selected-window destination, one client across reconnect, Close view
  detaches without killing, confirmed window/final-window termination displays
  absence and does not resurrect the session on later polls.
- Real Safari/iPhone/iPad, actual Windows Bopomofo/macOS switching hardware and
  native on-device reconnection were **not tested**. Chromium traces are not
  on-device verification. No independently extracted PR 1 patch has been built
  yet; [upstream-pr-plan.md](upstream-pr-plan.md) states the required split gate.

## Independent-review correction: linked-window target context

The original 57-test preparation did not cover linked windows. Independent
review reproduced a real blocker: a window belonging to both the configured
session and another session could pass HTTP membership validation, while
`select-window -t @id` selected it in the wrong session and reported success.

The helpers now require `(session, id)` and use exact `=session:@id` context.
A small shared tmux command helper checks **both** `session_name` and `window_id`
in the same tmux command queue as select/rename/kill. This is necessary because
tmux can silently resolve an unlinked/foreign `=session:@id` to that session's
current window. Guard refusal returns an explicit marker rather than falsely
reporting success. Literal rename arguments are quoted for tmux's command
parser, preserving quotes/dollar/semicolon text and ordinary direct-argv tmux
format/backslash behavior.

Added scratch regressions:

1. A linked-window HTTP selection changes only the configured session's active
   window, leaving the unrelated session's active window unchanged. Scoped
   rename remains correct for that shared window and preserves direct tmux
   name semantics.
2. Membership is observed, then an external CLI unlink happens. The test first
   demonstrates actual tmux context fallback, then proves select/rename/kill
   helpers refuse without altering either session; HTTP endpoints reject the
   now-unlinked id as well. This deterministically exercises the race state
   without adding a test-only server interception hook.

Focused `./node_modules/.bin/tsx --test test/windows.test.ts`: **15/15 passed**.
Full cached-Chromium suite and both typechecks were then rerun as above.
Patch locations: `src/tmux.ts` scoped helper/operations, `src/server.ts`
session-aware callers, `test/windows.test.ts` two added cases. No agreed
deletion/restart/default-mode semantics were changed by this correction.

## Independent-review correction: explicit lifecycle ordering/exact session targets

Independent review additionally reproduced a new optional-feature lifecycle
race: explicit window-mode restart killed its session, then began delayed
backend recreation; a later HTTP session kill previously acknowledged and
persisted a tombstone during that absence, after which the older restart
resurrected the target. This was not an inherited IME defect.

The existing destructive-operation queue now orders complete explicit restart
recreation, HTTP session termination and window termination. Legacy WS restart
also uses it. HTTP session kill still broadcasts and tombstones immediately,
then waits for earlier lifecycle work and its own exact session/base+mate kills
before returning success. Explicit operations remain permitted; later kill
wins rather than being silently undone by the earlier restart.

Bare `kill-session -t name` prefix matching in old HTTP/legacy WS paths was an
**inherited upstream behavior**, not introduced by window tabs. Those touched
paths now use `=name`, so an absent target/mate cannot kill a different session
whose name merely starts with it. This is targeting correctness, not name
immunity or a ban on destructive actions.

New `test/lifecycle.test.ts` uses unique scratch sockets, temporary
state/uploads and a temporary PATH wrapper forwarding the original argv to
real tmux. Filesystem gates deterministically hold only the relevant CLI
operation; ordinary attaches exec real tmux directly. Coverage: absent HTTP
base/mate preserve prefix keepers in both modes; a held WS restart kill loses
its target externally and fails exactly without killing the prefix keeper in
both modes; held window-mode restart recreation plus later HTTP kill waits,
keeps tombstones and leaves session absent even after a view attach attempt.
Focused lifecycle tests: **5/5 passed**, no skips.

The reviewer's original `/tmp/terminal-web-compat-restart-race.mjs` was also
replayed against corrected source. Its later kill returned HTTP 200 and final
`/api/windows` reported `sessionPresent:false`, `windows:[]`, with the target
and mate tombstones present; the earlier restart did not resurrect the target.

## Independent-review correction: initial attach waits for first fit

The window boot payload's early `resumeView()` no longer attaches before
`setShown()`'s layout animation frame. It unpauses immediately but waits until
`fit()` followed by `start()` owns the first connection. `connect()` also
checks `started`; OPEN/CONNECTING idempotence and stale-callback guards remain.
This fixes an introduced window-startup transient (unmeasured 80x24 attach,
then correction to the real size), not an original IME defect or a new size
policy. Ordinary shared current-window/size semantics are unchanged.

The existing single-socket startup regression now compares the first query's
`cols/rows` with xterm's actual resize dimensions and rejects a later startup
correction. An additional real-Chromium 1080x640 viewport case proves the first
query uses non-fallback measured dimensions and still opens exactly one
socket. The test captures outgoing resize frames per socket, not a fake xterm
measurement. Focused startup tests: **2/2 passed**.

Replaying the reviewer's `/tmp/terminal-web-compat-startup.test.mts` startup
case now reports:

```text
STARTUP_SOCKET ws://127.0.0.1:<ephemeral>/ws?session=input-fixture&cols=91&rows=24
CONTROL_FRAMES [ '{"type":"resize","cols":91,"rows":24}' ]
```

There is no preceding 80x24 connection. The full suite, both typechecks and an
independent temporary frontend build were rerun afterward as recorded above.

## Original deployment unchanged

Before isolation, hashes of original `public/` (including `public/dist`),
`src/`, `web/`, `docs/`, `test/`, `.env.example`, README and package manifests
were recorded in `/tmp/terminal-web-deployed-files-before-upstream.sha256`.
After implementation:

```bash
cd /home/liontree/terminal-web
sha256sum -c /tmp/terminal-web-deployed-files-before-upstream.sha256
cmp package-lock.json /tmp/terminal-web-package-lock-before-phase1.json
git status --short
git rev-parse HEAD
```

Hash check and byte comparison both passed (exit 0). Original HEAD/status
remain the original deployed dirty `feat/main-window-tabs` state. Original
lock/baseline SHA256:
`f03cd275e8c58dab4ef272ac5bb3c3a53a15e828cc5188f59bdb97938760b698`.
Read-only process inspection still shows original live server PIDs 4108351 and
4108363, started at 2026-10-13 15:53:11, pointing to
`/home/liontree/terminal-web/src/server.ts`. No service/unit changes or restarts
were issued, no deployed bundles were rebuilt/replaced, and the regression
fixtures never target production `main` or the default tmux socket.
