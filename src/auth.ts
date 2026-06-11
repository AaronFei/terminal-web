/**
 * Optional shared-token auth, for when the server is exposed beyond a trusted
 * network (e.g. via a public tunnel). When `AUTH_TOKEN` is set, every HTTP
 * request and WebSocket upgrade must carry a valid `tw_auth` cookie; otherwise
 * the visitor gets a small login page. Supplying `?token=…` once sets the
 * cookie (so the URL can be bookmarked) and redirects to a clean URL.
 *
 * This is a single shared secret, not per-user identity — keep the token long
 * and random. When `AUTH_TOKEN` is empty, auth is disabled and the server
 * behaves exactly as before (intended for trusted/tailnet-only deployments).
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const COOKIE = "tw_auth";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
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

/** Whether this request must present the token: enabled AND via Cloudflare. */
function authRequired(req: http.IncomingMessage, token: string): boolean {
  return Boolean(token) && viaCloudflare(req);
}

function hasValidCookie(req: http.IncomingMessage, token: string): boolean {
  const got = parseCookies(req.headers.cookie)[COOKIE];
  return typeof got === "string" && safeEqual(got, token);
}

/** True if the request needs no token, or carries the valid auth cookie. */
export function isAuthed(req: http.IncomingMessage, token: string): boolean {
  return !authRequired(req, token) || hasValidCookie(req, token);
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
  <form id="f" autocomplete="off">
    <h1>terminal-web</h1>
    <input id="t" type="password" placeholder="Access token" autofocus
      autocapitalize="off" autocomplete="current-password" spellcheck="false" />
    <button type="submit">Enter</button>
    ${err}
  </form>
</div>
<script>
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('t').value.trim();
    if (v) location.href = '/?token=' + encodeURIComponent(v);
  });
</script>
</body></html>`;
}

/**
 * Gate an HTTP request when auth is enabled. Returns true when it fully handled
 * the response (redirect after login, or served the login page) and the caller
 * should stop; false when the request is authed and should proceed normally.
 */
export function gateHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string,
): boolean {
  if (!authRequired(req, token)) return false; // disabled, or direct/tailnet

  const supplied = url.searchParams.get("token");
  if (supplied !== null) {
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
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPage("Wrong token."));
    return true;
  }

  if (hasValidCookie(req, token)) return false; // already signed in

  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end(loginPage(""));
  return true;
}
