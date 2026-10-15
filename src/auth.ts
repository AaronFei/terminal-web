/**
 * Request gating: the shared-token sign-in for Cloudflare-fronted requests,
 * and the Host / Origin checks every request goes through.
 *
 * Token: a request that arrives through Cloudflare must carry a valid `tw_auth`
 * cookie, or it gets a small login page. The page POSTs the token to /login,
 * which sets the cookie. Supplying `?token=…` on a GET still works for old
 * bookmarks: it sets the cookie and redirects to the same URL without it.
 *
 * This is a single shared secret, not per-user identity — keep the token long
 * and random. Direct/tailnet access needs no token, by design. With
 * `AUTH_TOKEN` empty, a Cloudflare-fronted request is refused outright: it
 * used to be let straight in, which made a tunnel set up before the token a
 * public shell.
 */
import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";

const COOKIE = "tw_auth";

/** Where the login form posts. */
const LOGIN_PATH = "/login";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    // A malformed value (`%E0`) makes decodeURIComponent throw. Some other
    // site's cookie on the same host is enough to send one, and a throw here
    // used to take the request down with a 500 — or, in the WebSocket upgrade,
    // escape the listener entirely. Skip that cookie and keep the rest.
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* not ours to fix */
    }
  }
  return out;
}

/** Constant-time compare; false on any length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * True if the request arrived through Cloudflare. The token gate applies ONLY
 * to these requests, so direct/tailnet access (e.g. http://<tailscale-ip>:8090)
 * stays open with no token. Cloudflare's edge always stamps cf-ray /
 * cf-connecting-ip; a forged header from a direct client only makes auth stricter
 * (it would then demand the token), never weaker — and a real tunnel request can
 * never lack them.
 */
function viaCloudflare(req: http.IncomingMessage): boolean {
  return Boolean(req.headers["cf-ray"] ?? req.headers["cf-connecting-ip"]);
}

function hasValidCookie(req: http.IncomingMessage, token: string): boolean {
  const got = parseCookies(req.headers.cookie)[COOKIE];
  return typeof got === "string" && safeEqual(got, token);
}

const NO_TOKEN_MESSAGE =
  "terminal-web: this server has no AUTH_TOKEN set, so access through the " +
  "public tunnel is refused. Set AUTH_TOKEN on the server and restart it.\n";

/**
 * Why a WebSocket upgrade must be refused on auth grounds, as a status line, or
 * null to let it through. Direct/tailnet: always through. Through Cloudflare:
 * 403 with no token configured (fail closed), 401 without the cookie.
 */
export function refuseUpgrade(req: http.IncomingMessage, token: string): string | null {
  if (!viaCloudflare(req)) return null;
  if (!token) return "403 Forbidden";
  return hasValidCookie(req, token) ? null : "401 Unauthorized";
}

function reqIsHttps(req: http.IncomingMessage): boolean {
  const xf = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(xf) ? xf[0] : xf) ?? "";
  // Behind a tunnel/proxy the edge sets X-Forwarded-Proto; only then is it safe
  // to mark the cookie Secure (a Secure cookie wouldn't work over plain-HTTP
  // tailnet access).
  return proto.split(",")[0]?.trim() === "https";
}

function authCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=31536000",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function loginPage(error: string): string {
  const err = error
    ? `<p class="err">${error.replace(/[<>&]/g, "")}</p>`
    : "";
  // A plain form POST, no script: the token travels in the body, so it stays
  // out of the address bar, the history and Cloudflare's request logs, which a
  // `?token=` URL did not.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>terminal-web — sign in</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; background:#1e1e1e; color:#d4d4d4;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }
  form { width:min(92vw,340px); background:#252526; border:1px solid #3a3a3a; border-radius:12px;
    padding:22px; box-shadow:0 8px 30px rgba(0,0,0,.5); }
  h1 { font-size:15px; margin:0 0 14px; color:#fff; }
  input { width:100%; box-sizing:border-box; background:#1e1e1e; color:#d4d4d4;
    border:1px solid #3a3a3a; border-radius:8px; padding:12px; font:inherit; font-size:15px; }
  button { width:100%; margin-top:12px; padding:12px; background:#2472c8; color:#fff;
    border:1px solid #3b8eea; border-radius:8px; font:inherit; font-size:15px; cursor:pointer; }
  button:active { background:#2069b8; }
  .err { color:#f14c4c; font-size:13px; margin:10px 0 0; }
</style></head>
<body><div class="wrap">
  <form method="post" action="${LOGIN_PATH}" autocomplete="off">
    <h1>terminal-web</h1>
    <input name="token" type="password" placeholder="Access token" autofocus required
      autocapitalize="off" autocomplete="current-password" spellcheck="false" />
    <button type="submit">Enter</button>
    ${err}
  </form>
</div>
</body></html>`;
}

function sendLoginPage(res: http.ServerResponse, error: string): void {
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end(loginPage(error));
}

/** The `token` field of a small form-urlencoded body, or null. */
async function readLoginToken(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 4096) return null; // a token is not this long
    chunks.push(buf);
  }
  const token = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token");
  return token === null ? null : token.trim();
}

/**
 * Gate an HTTP request on the token. Resolves true when it fully handled the
 * response (refusal, login page, or the redirect after signing in) and the
 * caller should stop; false when the request should proceed normally.
 */
export async function gateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const isLogin = method === "POST" && url.pathname === LOGIN_PATH;

  if (!viaCloudflare(req)) {
    // Open by design. A stray login POST just goes home.
    if (isLogin) {
      res.writeHead(303, { Location: "/" });
      res.end();
      return true;
    }
    return false;
  }

  // Through the tunnel with no token configured: refuse rather than let the
  // whole internet into a shell.
  if (!token) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(NO_TOKEN_MESSAGE);
    return true;
  }

  if (isLogin) {
    const supplied = await readLoginToken(req);
    if (supplied && safeEqual(supplied, token)) {
      // 303 so the browser follows with a GET, and a reload of the page it
      // lands on doesn't offer to resubmit the token.
      res.writeHead(303, {
        "Set-Cookie": authCookie(token, reqIsHttps(req)),
        Location: "/",
      });
      res.end();
      return true;
    }
    sendLoginPage(res, "Wrong token.");
    return true;
  }

  // Old bookmarks carry the token in the URL. Still honoured on a GET, then
  // dropped from the URL straight away.
  const supplied = url.searchParams.get("token");
  if (supplied !== null && (method === "GET" || method === "HEAD")) {
    if (safeEqual(supplied, token)) {
      url.searchParams.delete("token");
      const qs = url.searchParams.toString();
      res.writeHead(302, {
        "Set-Cookie": authCookie(token, reqIsHttps(req)),
        Location: url.pathname + (qs ? `?${qs}` : ""),
      });
      res.end();
      return true;
    }
    sendLoginPage(res, "Wrong token.");
    return true;
  }

  if (hasValidCookie(req, token)) return false; // already signed in

  sendLoginPage(res, "");
  return true;
}

// ---------------------------------------------------------------------------
// Host and Origin.
//
// Tailnet access needs no token, so on the tailnet the browser itself is the
// only thing between a web page and a shell. Two ways a page could get one:
//
//   * Cross-site requests. Any page open in a browser on the tailnet can POST
//     to http://100.x:8090/api/sessions/kill, or open ws://100.x:8090/ws and
//     type into a terminal — a WebSocket isn't covered by CORS at all. The
//     browser does say where such a request came from, in Origin, so a
//     state-changing request or an upgrade whose Origin isn't this server is
//     refused.
//   * DNS rebinding. A page on evil.example re-points its own name at
//     100.x, and from then on its requests ARE same-origin as far as the
//     browser can tell — but they carry `Host: evil.example`. So a dotted Host
//     that isn't an IP, localhost, a tailnet name, or listed in ALLOWED_HOSTS
//     is refused.
//
// Cloudflare-fronted requests skip the Host check: the token covers them, and
// their Host is always the tunnel's real hostname. No CORS headers are sent;
// the iframe the launcher embeds makes same-origin requests of its own.
// ---------------------------------------------------------------------------

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The hostname in a Host header, lower-cased, without port or brackets. */
function hostnameOf(host: string): { name: string; bracketed: boolean } {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return { name: end < 0 ? h.slice(1) : h.slice(1, end), bracketed: true };
  }
  const colon = h.lastIndexOf(":");
  return { name: (colon < 0 ? h : h.slice(0, colon)).replace(/\.$/, ""), bracketed: false };
}

/** Whether a request's Host may reach this server (see above). */
export function hostAllowed(req: http.IncomingMessage, allowedHosts: string[]): boolean {
  if (viaCloudflare(req)) return true;
  const host = headerValue(req.headers.host);
  // No Host at all is not a browser, and so not a rebinding page.
  if (!host) return true;
  const { name, bracketed } = hostnameOf(host);
  if (bracketed) return net.isIPv6(name);
  if (net.isIPv4(name)) return true;
  // Anything past this point must at least look like a hostname, so an odd
  // Host (an unbracketed IPv6, userinfo, a path) can't slip through as a
  // "single label" below.
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name)) return false;
  // A single label — `localhost`, a MagicDNS short name like `afei-company-nuc`
  // — can't be registered by anyone else, so it can't be rebound.
  if (!name.includes(".")) return true;
  if (name.endsWith(".ts.net")) return true;
  return allowedHosts.includes(name);
}

/**
 * Whether a request's Origin, if it sent one, is this server. A missing Origin
 * is fine — curl and scripts don't send one, and a browser always does on the
 * requests this guards. `Origin: null` (sandboxed frames, file://, some
 * redirects) can't be told apart from an attacker, so it is refused.
 *
 * Same-origin is judged on host:port against the Host header, not the scheme:
 * behind the tunnel the browser speaks https to Cloudflare and Cloudflare
 * speaks http to us, so the schemes never match.
 */
export function originAllowed(req: http.IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === undefined) return true;
  const host = headerValue(req.headers.host);
  if (!host || origin === "null") return false;
  // Host goes into a URL below; anything that would parse as userinfo, a path
  // or a query there could make two different hosts compare equal.
  if (/[@/?#\\\s]/.test(host)) return false;
  try {
    const o = new URL(origin);
    // Parsed with the Origin's scheme so a default port written out on one
    // side (`Host: x:443`) and left off the other compares equal.
    const h = new URL(`${o.protocol}//${host}`);
    return o.host === h.host;
  } catch {
    return false;
  }
}
