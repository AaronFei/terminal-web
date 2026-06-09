# terminal-web

A web-based terminal: open a browser tab, get a real shell. The shell runs
inside a **tmux** session, so closing the tab (or losing your network) just
detaches — your programs keep running and reattach when you come back.

Built with [xterm.js](https://xtermjs.org/) on the front end and a small
Node.js + TypeScript server using [`ws`](https://github.com/websockets/ws) and
[`node-pty`](https://github.com/microsoft/node-pty) on the back end.

It's designed to live on your **Tailnet**: the server binds to your Tailscale
IP and there is **no application-level authentication** — anyone who can reach
the address gets a full shell. See [Security](#security).

---

## Architecture

```
                         WebSocket: /ws?session=NAME
                  binary = raw bytes, text = JSON control
  +-----------------+   <------------------------------->   +--------------------+
  |     Browser     |                                       |   Node.js server   |
  |   (xterm.js)    |  --- input bytes (binary frame) --->  |   ws + node-pty    |
  |  FitAddon       |  <-- output bytes (binary frame) ---  |                    |
  |  WebLinksAddon  |  --- {resize|ping} (text frame)  -->  |   spawns a pty     |
  |  WebglAddon     |  <-- {pong} (text frame)         ---  |   per connection   |
  +-----------------+                                       +---------+----------+
         ^                                                            |
         | static files (/, /styles.css, /dist/*.js, /dist/*.css)    | pty runs:
         +------------------------------------------------------------+  tmux new-session -A -s NAME
                                                                      v
                                                          +-------------------------+
                                                          |     tmux server         |
                                                          |  session "NAME" ------> | your shell + programs
                                                          |  (survives disconnect)  |
                                                          +-------------------------+
```

- The browser streams keystrokes to the server as **binary** WebSocket frames;
  the server writes them straight to the pty.
- The pty's output is streamed back as **binary** frames; xterm renders it.
- **Text** frames carry JSON control messages (`resize`, `ping`/`pong`).
- The pty runs `tmux new-session -A -s NAME`, so the same named session is
  reused (or created) on every connect. The tmux server outlives the pty.

---

## Prerequisites

These are CLI prerequisites — they are **not** bundled or installed by this
project:

- **Node.js 18+** (ESM, runs the server via `tsx`)
- **tmux** — the session backend (`brew install tmux` on macOS)
- **tailscale** — **optional**. Only used to auto-detect which IP to bind to.
  Not installed? It's fine — set `HOST` yourself (see
  [Without Tailscale](#without-tailscale-lan--intranet)).

Development was done on macOS.

---

## Install

```bash
npm install
```

> **Note:** `node-pty` is a native addon and **compiles on install**. You need
> a working C/C++ toolchain. On macOS that means the Xcode Command Line Tools:
> `xcode-select --install`. See [Troubleshooting](#troubleshooting) if the
> build fails.

---

## Build

Bundle the client (xterm.js + addons) with esbuild into `public/dist/`:

```bash
npm run build
```

This produces `public/dist/terminal.js` and `public/dist/terminal.css`
(esbuild derives the CSS file name from the `web/terminal.ts` entry, which
imports xterm's stylesheet). `public/dist/` is gitignored.

---

## Run

### Quick start (recommended)

```bash
npm start
# or, with Tailscale auto-detection and an auto-build if needed:
bash scripts/start.sh
```

`scripts/start.sh`:

1. Warns if `tmux` or `tailscale` are missing.
2. Builds the client bundle if `public/dist/terminal.js` is absent.
3. Detects your Tailscale IPv4 (`tailscale ip -4 | head -1`) and exports it as
   `HOST` (unless `HOST` is already set).
4. Runs `npm start` and prints the reachable `http://<host>:<port>` URL.

`npm start` alone just runs `tsx src/server.ts`; the server itself also
detects the Tailscale IP for `HOST` when `HOST` is unset, and logs the URLs it
binds (highlighting the Tailscale one).

Then open the printed URL, e.g. `http://100.x.y.z:8090/`.

### Without Tailscale (LAN / intranet)

Tailscale is **optional** — it's only used to auto-pick the bind address. From
a clean clone the only hard requirements are **Node 18+** and **tmux**. Without
tailscale, set `HOST` yourself:

```bash
git clone <repo> && cd terminal-web
npm install
npm run build

# bind to a specific LAN/intranet IP...
HOST=192.168.1.50 PORT=8090 npm start
# ...or bind every interface (reachable on all of the host's IPs)
HOST=0.0.0.0 PORT=8090 npm start
```

`scripts/start.sh` and `scripts/service.sh install` also work without tailscale
— they just warn, then fall back to the `HOST` you set (or `0.0.0.0`). Open
`http://<that-ip>:8090/` from any machine that can reach it.

> **Security:** there is **no app-level auth** and traffic is plain HTTP —
> anyone who can reach the bound `IP:port` gets a full shell. On a Tailnet that
> is limited to your authorized devices; on a shared LAN it's everyone on that
> segment. Only expose it on a network you trust (or put it behind a firewall).

### Development

```bash
npm run dev   # -> bash scripts/dev.sh
```

`scripts/dev.sh` runs the esbuild watcher (`node esbuild.mjs --watch`) in the
background and the server with reload (`tsx watch src/server.ts`) in the
foreground. Editing `web/terminal.ts` rebuilds the bundle; editing server code
restarts the server. The background watcher is killed automatically when you
stop the script (Ctrl-C).

---

## Running as a background service (launchd)

To keep terminal-web running across logins and restarts (instead of a terminal
window you have to leave open), install it as a per-user launchd agent:

```bash
bash scripts/service.sh install     # write plist, load, start at login + on crash
bash scripts/service.sh status      # show launchd state + an HTTP probe
bash scripts/service.sh logs        # tail logs/launchd.{out,err}.log
bash scripts/service.sh restart     # after changing server code
bash scripts/service.sh uninstall   # stop and remove
```

`install` writes `~/Library/LaunchAgents/com.aaronfei.terminal-web.plist`,
pinning the node path, the repo path, and `HOST`/`PORT`. By default `HOST` is
your Tailscale IPv4 (override with `HOST=… PORT=… bash scripts/service.sh
install`). `KeepAlive` restarts the server if it exits; `ThrottleInterval`
avoids a hot loop while Tailscale is still coming up at boot — binding to the
Tailscale IP fails until the tailnet is up, then succeeds on the next retry.

Logs go to `logs/launchd.out.log` / `logs/launchd.err.log`. After editing
**server** code run `scripts/service.sh restart`; after editing **frontend**
code run `npm run build` (the service serves the prebuilt bundle).

---

## How resume works

The pty doesn't run your shell directly — it runs
`tmux new-session -A -s NAME` (with `-A` meaning "attach if it exists, else
create"). So:

- **Disconnecting** (closing the tab, sleeping the laptop, dropping Wi-Fi)
  closes the WebSocket. The server kills the pty, which only **detaches** the
  tmux client. The tmux *server* and your session — including every running
  program — keep going.
- **Reconnecting** opens a new WebSocket, spawns a new pty, and re-attaches to
  the same named session. tmux repaints the screen and you're back where you
  left off.

The front end intentionally does **not** reset the terminal on reconnect, so
your local xterm scrollback is preserved and tmux's repaint lands cleanly. A
subtle "reconnecting…" overlay appears while it retries (capped backoff).

---

## How scrolling works

Scrolling is handled by **tmux**, configured in `tmux/web.tmux.conf`:

- `set -g mouse on` — mouse-wheel scrolling drops you into tmux copy-mode to
  browse history; scrolling back to the bottom returns to the live shell.
- `set -g history-limit 100000` — deep scrollback. Increase this if you need
  more lines retained (it costs memory per pane).

xterm.js also keeps a large local scrollback (`scrollback: 100000`), but tmux
owns the authoritative history (important after a reattach).

> The tmux status bar is hidden (`set -g status off`) for a clean full-screen
> look. To bring it back, comment out that line in `tmux/web.tmux.conf`, or at
> runtime run `tmux set -g status on`.

---

## On-screen keys & control bar (touch / iPad)

iPad/phone soft keyboards lack arrow keys, Esc, Tab, and modifiers, so the page
adds two bars:

- **Top control bar** — a connection dot + the session name, plus buttons:
  `A−`/`A+` (font size, persisted), `⌨ Keys` (toggle the key bar), and `⤢`
  (fullscreen).
- **Bottom key bar** — `Esc Tab Ctrl Alt ← ↑ ↓ → Home End PgUp PgDn ^C | ~ / -`,
  horizontally scrollable. `Ctrl` and `Alt` are **sticky**: tap to arm them (they
  highlight), then the next key is sent with that modifier — e.g. `Ctrl` then `c`
  sends `Ctrl-C`; `Ctrl`/`Alt` + an arrow sends the xterm modified sequence.

The key bar shows by default on touch devices and is hidden on desktop; your
choice is remembered (localStorage). Tapping a key keeps focus on the terminal
so the soft keyboard stays up, and the bar lifts above the iOS keyboard via the
`visualViewport` API.

---

## Switching sessions

Each tmux session is independent. Pick one with the `session` query parameter:

```
http://<host>:<port>/?session=work
http://<host>:<port>/?session=scratch
```

Without `?session=`, the default (`DEFAULT_SESSION`, default `web`) is used.
Names are sanitized to `[A-Za-z0-9_-]{1,64}`; anything invalid falls back to
`web`. Open different sessions in different tabs to run independent shells that
all survive disconnects.

---

## Environment variables

All are optional. Copy `.env.example` to `.env` to override defaults. `.env` is
loaded by `scripts/start.sh` and `scripts/dev.sh` (`npm run dev`). Running
`npm start` (tsx) directly does **not** auto-load `.env` — export the vars in
your shell instead, e.g. `HOST=100.x.y.z PORT=8090 npm start`.

| Variable          | Default                                              | Description                                                                 |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `PORT`            | `8090`                                               | Port the HTTP/WebSocket server listens on.                                  |
| `HOST`            | Tailscale IPv4 (`tailscale ip -4`), else `0.0.0.0`   | Address to bind. Set explicitly to pin a specific interface/IP.             |
| `DEFAULT_SESSION` | `web`                                                | tmux session name used when the client doesn't pass `?session=NAME`.        |
| `UPLOAD_DIR`      | `~/terminal-web-uploads`                             | Where pasted/dropped images are saved (see below).                          |
| `UPLOAD_RETENTION_HOURS` | `72`                                          | Auto-delete uploads older than this (0 = never by age).                     |
| `UPLOAD_MAX_FILES` | `100`                                               | Keep at most this many uploads, newest first (0 = unlimited).               |

---

## Pasting images (for Claude Code & other AI CLIs)

A terminal is a text stream, so you can't paste pixels into it. Instead, when
you **paste** an image (Cmd/Ctrl-V) or **drag-drop** an image file onto the
terminal, the browser uploads it to the server (`POST /upload`), which saves it
under `UPLOAD_DIR` (default `~/terminal-web-uploads`) and returns the path. The
page then **types that absolute path at the prompt**.

So to show an image to Claude Code (or any CLI that reads image paths): paste
the image, then press Enter — Claude Code picks up the inserted path and reads
the image. Images are capped at 25 MB and saved `0600`.

To stop the folder growing forever, uploads are auto-pruned on boot and after
each upload: files older than `UPLOAD_RETENTION_HOURS` (default 72h) are
deleted, then only the newest `UPLOAD_MAX_FILES` (default 100) are kept. Only
`clip-*` image files are touched. Set either to `0` to disable that limit.

> The upload endpoint has no auth beyond the tailnet, same as the terminal —
> anyone on your tailnet can POST an image into `UPLOAD_DIR`.

---

## Security

**There is no application-level authentication.** Anyone who can reach the
bound address gets an interactive shell as the user running the server.

- Keep it **Tailnet-only**: leave `HOST` pointed at your Tailscale IP (the
  default behavior) so the server is not exposed on your LAN or the public
  internet. Avoid binding to `0.0.0.0` on untrusted networks.
- Lock it down further with **Tailscale ACLs** so only specific devices/users
  on your tailnet can reach the port.
- The server speaks **plain HTTP** (no TLS). Because it's not a secure context,
  the browser **`navigator.clipboard` API may be unavailable or limited** —
  copy/paste falls back to tmux's own copy-mode and your terminal's native
  selection. (Tailscale can provide HTTPS via `tailscale serve` if you want a
  secure context; that's outside this project's scope.)

Treat exposing this as equivalent to handing out SSH access.

---

## Troubleshooting

**`node-pty` fails to build / `npm install` errors with node-gyp**
`node-pty` is a native addon. Ensure you have a C/C++ toolchain:
- macOS: `xcode-select --install`
- Make sure your Node version matches what `node-pty` supports (Node 18+).
- Try a clean reinstall: `rm -rf node_modules && npm install`.

**"tmux: command not found" / sessions don't start**
Install tmux (`brew install tmux`). The server spawns `tmux` per connection
and loads `tmux/web.tmux.conf`; without tmux on `PATH`, connections fail.

**Port already in use (`EADDRINUSE`)**
Another process holds the port. Find it with `lsof -i :8090` (adjust the port)
and stop it, or start with a different port: `PORT=8091 npm start`.

**Tailscale IP not detected / binds to `0.0.0.0`**
Make sure Tailscale is running and connected: `tailscale status` and
`tailscale up`. Confirm `tailscale ip -4` prints an address. You can always
set `HOST` explicitly to bypass detection.

**Client shows "reconnecting…" and never connects**
The server may not be running, or you can't reach `HOST:PORT`. Check the
server logs for the bound URL, verify you're on the tailnet, and confirm the
port isn't blocked.

**Blank page / terminal doesn't render**
Make sure the client bundle was built: `npm run build` (or use
`scripts/start.sh`, which builds it automatically). Check the browser console
for errors loading `/dist/terminal.js`.
