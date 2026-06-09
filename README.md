# terminal-web

A web-based terminal: open a browser tab, get a real shell. The shell runs
inside a **tmux** session, so closing the window (or losing your network) just
detaches — your programs keep running and reattach when you come back.

Built with [xterm.js](https://xtermjs.org/) on the front end and a small
Node.js + TypeScript server using [`ws`](https://github.com/websockets/ws) and
[`node-pty`](https://github.com/microsoft/node-pty) on the back end.

It's designed to live on your **Tailnet**: the server binds to your Tailscale
IP and there is **no application-level authentication** — anyone who can reach
the address gets a full shell. See [Security](#security).

**Features**

- **Resumable** sessions (tmux) — survive disconnect, refresh and sleep
- Deep **scrollback** (mouse-wheel)
- **Multi-session tabs** — open (`+`), close-and-kill (`×`), restart (`⟳`)
- **On-screen keys** for iPad/touch — arrows, Esc/Tab/sticky Ctrl·Alt, Copy/Paste
- **Copy & paste** that works over plain HTTP (no HTTPS required)
- **Attach images** (button / paste / drag) → upload → insert path, for **Claude
  Code** and other AI CLIs
- Font size, fullscreen, IME (CJK) input, and a `?` help overlay
- Runs over **Tailscale** or any **LAN/intranet** IP
- Optional **background service** (launchd on macOS, systemd on Linux)

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
- **Text** frames carry JSON control messages: `resize`, `ping`/`pong`,
  `restart` and `kill` (session control), and an optional `debug` trace.
- The pty runs `tmux new-session -A -s NAME`, so the same named session is
  reused (or created) on every connect. The tmux server outlives the pty.

---

## Prerequisites

These are CLI prerequisites — they are **not** bundled or installed by this
project:

- **Node.js 18+** (ESM, runs the server via `tsx`)
- **tmux** — the session backend (`brew install tmux` on macOS,
  `sudo apt install tmux` on Debian/Ubuntu)
- **Linux only:** a C/C++ toolchain + Python 3 to build `node-pty`
  (`sudo apt install -y build-essential python3`) — see [Install](#install)
- **tailscale** — **optional**. Only used to auto-detect which IP to bind to.
  Not installed? It's fine — set `HOST` yourself (see
  [Without Tailscale](#without-tailscale-lan--intranet)).

Development was done on macOS.

---

## Install

```bash
npm install
```

> **Note:** `node-pty` is a native addon. It ships **prebuilt** binaries for
> macOS and Windows, but on **Linux it compiles from source on install** — so
> you need a C/C++ toolchain + Python 3
> (`sudo apt install -y build-essential python3` on Debian/Ubuntu). On macOS,
> if no prebuilt matches your Node version it also compiles, which needs the
> Xcode Command Line Tools (`xcode-select --install`). See
> [Troubleshooting](#troubleshooting) if install fails.

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

## Running as a background service (launchd / systemd)

To keep terminal-web running across logins and restarts (instead of a terminal
window you have to leave open), install it as a per-user service. The same
helper auto-detects the platform — **launchd on macOS, systemd on Linux**:

```bash
bash scripts/service.sh install     # write unit, load, start at login/boot + on crash
bash scripts/service.sh status      # show state + an HTTP probe
bash scripts/service.sh logs        # tail the service logs
bash scripts/service.sh restart     # after changing server code
bash scripts/service.sh uninstall   # stop and remove
```

`install` pins the node path, the repo path, and `HOST`/`PORT` into the unit.
By default `HOST` is your Tailscale IPv4, else `0.0.0.0` (override with
`HOST=… PORT=… bash scripts/service.sh install`). The service auto-restarts if
it exits, with a 10 s back-off so it doesn't hot-loop while the network (or
Tailscale) is still coming up at boot.

- **macOS:** writes `~/Library/LaunchAgents/com.aaronfei.terminal-web.plist`;
  logs to `logs/launchd.out.log` / `logs/launchd.err.log`.
- **Linux:** writes `~/.config/systemd/user/terminal-web.service`, runs
  `systemctl --user enable --now`, and tries `loginctl enable-linger` so it
  survives logout / starts at boot (run `sudo loginctl enable-linger $USER`
  yourself if it couldn't). Logs go to the journal
  (`journalctl --user -u terminal-web -f`).

After editing **server** code run `scripts/service.sh restart`; after editing
**frontend** code run `npm run build` (the service serves the prebuilt bundle).

---

## How resume works

The pty doesn't run your shell directly — it runs
`tmux new-session -A -s NAME` (with `-A` meaning "attach if it exists, else
create"). So:

- **Disconnecting** — closing the *browser* tab/window, refreshing, sleeping
  the laptop, or dropping Wi-Fi — closes the WebSocket. The server kills the
  pty, which only **detaches** the tmux client. The tmux *server* and your
  session (every running program) keep going.
- **Reconnecting** opens a new WebSocket, spawns a new pty, and re-attaches to
  the same named session. tmux repaints the screen and you're back where you
  left off.

> Closing a **tab inside the app** (the `×`) is different: it *kills* that tmux
> session for good. So to keep a job running, just close the window or let the
> connection drop — don't press `×`. See [Sessions & tabs](#sessions--tabs).

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

- **Top bar** — session **tabs** on the left (see below) and controls on the
  right: `A−`/`A+` (font size, persisted), `⌨` (toggle the key bar), `⟳`
  (restart the session), an **image** button (attach an image), `⤢`
  (fullscreen), and `?` (a help overlay — also shown once on first visit).
- **Bottom key bar** — `Copy Paste Esc Tab Ctrl Alt ← ↑ ↓ → Home End PgUp PgDn
  ^C | ~ / -`, horizontally scrollable. `Ctrl` and `Alt` are **sticky**: tap to
  arm them (they highlight), then the next key is sent with that modifier — e.g.
  `Ctrl` then `c` sends `Ctrl-C`; `Ctrl`/`Alt` + an arrow sends the xterm
  modified sequence.

The key bar shows by default on touch devices and is hidden on desktop; your
choice is remembered (localStorage). Tapping a key keeps focus on the terminal
so the soft keyboard stays up, and the bar lifts above the iOS keyboard via the
`visualViewport` API.

---

## Sessions & tabs

Each tmux session is independent, and the top bar shows one **tab** per open
session (with a live connection dot). 

- **`+`** opens a new session (you're prompted for a name).
- **`×`** closes the tab **and kills that tmux session for good** (its programs
  are terminated). This is *not* the same as disconnecting — see
  [How resume works](#how-resume-works).
- **`⟳`** restarts the active session: kills it and reconnects into a fresh one.
- Open tabs and the active tab are remembered (localStorage) and restored on
  reload.

You can also pick the session for a fresh page with the `session` query
parameter (handy for bookmarks/links):

```
http://<host>:<port>/?session=work
```

Without `?session=`, the default (`DEFAULT_SESSION`, default `web`) is used.
Names are sanitized to `[A-Za-z0-9_-]{1,64}`; anything invalid falls back to
`web`.

---

## Copy, paste & clipboard

The browser Clipboard **API** needs a *secure context* (HTTPS or
`http://localhost`), so over a plain `http://<ip>` URL it's blocked. This app
works around that so you don't strictly need HTTPS:

- **Select** — tmux mouse mode owns plain dragging, so hold **Option** (macOS)
  or **Shift** (Windows/Linux) and drag to select. Selecting copies
  automatically (via `execCommand`, which works over HTTP), or tap **Copy**.
- **Paste** — on a desktop, click the terminal and press **⌘V** /
  **Ctrl+Shift+V** (the native paste works over HTTP). On touch/HTTP, tap
  **Paste** in the key bar: a small box pops up, you paste into it, and it's
  sent to the terminal.
- On HTTPS (e.g. `tailscale serve`) the Clipboard API is unlocked and the
  Copy/Paste buttons work directly everywhere, including iPad.

The `?` help overlay summarizes these (with the right keys for your OS).

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

A terminal is a text stream, so you can't paste pixels into it. Instead there
are three ways to attach an image; each uploads it to the server (`POST
/upload`), which saves it under `UPLOAD_DIR` (default `~/terminal-web-uploads`)
and returns the path, and the page then **types that absolute path at the
prompt**:

- The **image button** in the top bar — pick a file or take a photo. This is
  the most reliable everywhere (incl. iPad) and over plain HTTP.
- **Paste** an image (Cmd/Ctrl-V) into the terminal.
- **Drag-drop** an image file onto the terminal.

So to show an image to Claude Code (or any CLI that reads image paths): attach
it, then press Enter — Claude Code picks up the inserted path and reads the
image. Images are capped at 25 MB and saved `0600`.

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
- The server speaks **plain HTTP** (no TLS), which isn't a *secure context*, so
  the browser's `navigator.clipboard` API is blocked. Copy/paste still works via
  fallbacks — see [Copy, paste & clipboard](#copy-paste--clipboard). For the
  native clipboard (and HTTPS), put it behind a TLS proxy such as
  `tailscale serve`.

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

---

## License

MIT © 2026 AaronFei. See [LICENSE](LICENSE).
