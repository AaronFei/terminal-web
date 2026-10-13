# Keyboard input regressions

## Reproduced causes

1. **Phase-one startup opens two WebSockets / ptys.** `initWindows()` calls
   `setShown(true)`, which schedules `start()` on the next layout animation
   frame. Applying the boot windows payload calls `resumeView()` first.
   Without an OPEN/CONNECTING guard in `connect()`, both paths attach. Two
   tmux output streams render into one xterm and can resemble doubled typing.
   An early resume also attached at unmeasured 80x24 before the layout frame
   corrected it to the real dimensions. Initial resume now unpauses but waits
   for `fit()` -> `start()`; idempotent/stale-socket guards remain. Browser
   regressions check one socket and initial query dimensions matching xterm's
   measured size, including a wide viewport. The real scratch-server test
   checks one attached tmux client / pty.
2. **Independent inherited IME defect: 229 rescue and xterm can send the same key.** Blocking
   only keydown in the custom key handler leaves keypress and insertText input
   available to xterm. Its payload is followed by the rescue's payload after
   90ms. The tests reproduce keypress, input before/after keyup, and late input.
3. **Independent inherited IME defect: composition has two commit paths.** The app sends compositionend.data,
   while xterm's insertText fallback can send the trailing native input too.
   The old non-ASCII-only string dedup did not cover ASCII commits. Its
   pre-edit suffix / elapsed-time heuristic also dropped legitimate repeated
   CJK text after composition.

Cause 1 was introduced by the new window-view startup path. Causes 2/3 were
already in the original session-mode input handling and are suitable for a
separate input-fix PR; they are not all caused by window tabs. Socket-generation
guards are reusable lifecycle safety, but their demonstrated duplicate-startup
trigger is the window feature. See [upstream-pr-plan.md](upstream-pr-plan.md).

Input ownership now follows DOM events, not a character-content debounce:
ordinary hardware input stays xterm-owned; a 229 key gets one delivery record
shared by its rescue, keypress and input; compositionend owns its commit and
its trailing native input. The trailing-input marker expires at the next task
when no input follows. The existing 90ms Safari no-input rescue remains.
Textareas are cleared after paste/commit without clearing live pre-edit, and
reconnect does not refocus an active composition. Stale socket callbacks cannot
disconnect or render into a newer view.

## Run

```bash
npx tsc --noEmit
CHROMIUM_BIN=/path/to/chromium npm test
```

`npm test` runs `test/windows.test.ts`, `test/legacy.test.ts`,
`test/lifecycle.test.ts` and `test/input.test.ts`. The browser suite
uses the existing `ws` and `esbuild` dependencies, with no Playwright npm
package required. If CHROMIUM_BIN is unset, it looks for Chromium on PATH and
in `~/.cache/ms-playwright/chromium-*`. If no browser is available, the browser
suite is explicitly **skipped**; that is not a browser pass.

The browser fixture bundles `web/terminal.ts` into an OS temporary directory,
serves the real app and xterm, and captures binary WebSocket frames. Chromium
CDP supplies trusted hardware keys, special keys, auto-repeat, native IME and
input-only emoji. Synthetic IME event traces reproduce additional event orders
against xterm's actual listeners.

One browser test proxies API/WebSocket traffic to a real server on a loopback
free port, using a unique `tmux -L twi*` socket and `twis*` session plus temporary
state/upload directories. A raw-stdin recorder inside tmux verifies exact
received bytes (including deliberate repeated characters), correct destination
after a window-tab change, and one attached client across reconnect. Cleanup
closes only those child processes and the named scratch socket.

Window and legacy lifecycle tests use separate scratch sockets and scratch
sessions. They do not inspect production `main` or use the default socket.
Legacy tests cover both unset and explicit `WINDOW_MODE=0`, including create,
label rename/adopt, kill/tombstones, explicit target restart, split cwd, init
and reconnect. Window tests cover explicit session-management APIs and allowed
final-window termination, even when that leaves no tmux server. Browser tests
also cover failed mode initialization and explicit retry into legacy mode.
Do not substitute a production socket for the generated scratch name.
No test rebuilds `public/dist`, restarts the live service, or writes to
production `main`.

## Not verified

A real iPhone/iPad Safari keyboard, Windows Bopomofo, macOS CapsLock IME
switching, and an actual device disconnect/reconnect have not been tested.
Chromium traces/native IME transactions do not substitute for that coverage.
The original report did not specify device/browser/input method, so these
reproduced defects do not prove which path caused that particular symptom.
Do not claim on-device verification or a production deployment from this test
suite alone.
