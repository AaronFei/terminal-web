/**
 * Passkey (WebAuthn) ceremonies: the options the browser needs and the
 * verification of what it sends back. The HTTP side is in auth.ts; the stored
 * passkeys and sessions are in auth-store.ts; the cryptography is
 * @simplewebauthn/server's.
 *
 * The RP ID is the hostname of the request, so each host (and each hostname a
 * host is reached by) has passkeys of its own; nothing here names a domain.
 *
 * Challenges are random, single-use (taken out of the map on the first verify
 * that names them, whatever the outcome), tied to their RP ID and to the kind
 * of ceremony, and expire after five minutes. At most MAX_PENDING wait at
 * once; past that the oldest are dropped.
 */
import crypto from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  MAX_PASSKEYS,
  addPasskey,
  findPasskey,
  listPasskeys,
  passkeyUserId,
  touchPasskey,
} from "./auth-store.js";

const RP_NAME = "terminal-web";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 100;
/** How long the browser is told the ceremony may take. */
const CEREMONY_TIMEOUT_MS = 120_000;
/**
 * Key types a new passkey may use: EdDSA, ES256, RS256 (COSE ids), which is
 * what every platform authenticator offers. Named here rather than left to the
 * library's default, which on a new enough Node also offers ML-DSA-44 and, to
 * find out, probes an experimental Web Crypto API (with a warning in the log).
 */
const ALGORITHMS = [-8, -7, -257];
export const MAX_NAME_LENGTH = 64;

type Kind = "login" | "register";

interface Pending {
  challenge: string;
  rpId: string;
  kind: Kind;
  expiresAt: number;
}

/** challenge id -> challenge; insertion order is age. */
const pending = new Map<string, Pending>();

function putChallenge(challenge: string, rpId: string, kind: Kind): string {
  const now = Date.now();
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  const id = crypto.randomBytes(16).toString("base64url");
  pending.set(id, { challenge, rpId, kind, expiresAt: now + CHALLENGE_TTL_MS });
  return id;
}

/** Take a challenge out (single use) and return it if it fits; null otherwise. */
function takeChallenge(id: unknown, rpId: string, kind: Kind): string | null {
  if (typeof id !== "string") return null;
  const p = pending.get(id);
  if (!p) return null;
  pending.delete(id);
  if (p.expiresAt <= Date.now() || p.rpId !== rpId || p.kind !== kind) return null;
  return p.challenge;
}

/** Where a request is being made: the RP ID and the origin the browser will report. */
export interface Party {
  rpId: string;
  origin: string;
}

/** A ceremony's result: a value, or an HTTP status and a message safe to show. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const fail = <T>(status: number, error: string): Outcome<T> => ({ ok: false, status, error });

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The shape every credential response must have before the library sees it. */
function looksLikeCredential(v: unknown): v is { id: string; response: Record<string, unknown> } {
  return (
    isObject(v) &&
    typeof v.id === "string" &&
    /^[A-Za-z0-9_-]{1,1366}$/.test(v.id) &&
    isObject(v.response) &&
    typeof v.response.clientDataJSON === "string"
  );
}

/**
 * The top-level page's origin, when the ceremony ran inside a cross-origin
 * iframe (the launcher). Accepted whatever it is: a page can only run a
 * ceremony in our frame if it was granted `publickey-credentials-get`, and the
 * result goes to this server, not to the embedding page.
 */
function topOriginOf(clientDataJSON: string): string | undefined {
  try {
    const cd: unknown = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    if (isObject(cd) && cd.crossOrigin === true && typeof cd.topOrigin === "string") {
      return cd.topOrigin;
    }
  } catch {
    /* the library reports it */
  }
  return undefined;
}

/**
 * A library error, fit for one log line. Its messages can quote client data
 * (an origin, a challenge), so: the first line only, control characters out,
 * and short.
 */
function errorLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split("\n")[0] ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "?").slice(0, 160);
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export async function loginOptions(
  party: Party,
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  // Discoverable credentials: no allowCredentials, so the browser shows its
  // own picker, and an empty one when this host has no passkey yet.
  const options = await generateAuthenticationOptions({
    rpID: party.rpId,
    allowCredentials: [],
    userVerification: "preferred",
    timeout: CEREMONY_TIMEOUT_MS,
  });
  return { challengeId: putChallenge(options.challenge, party.rpId, "login"), options };
}

/** Verify a sign-in. On success, the credential id the session is for. */
export async function loginVerify(party: Party, body: unknown): Promise<Outcome<string>> {
  if (!isObject(body)) return fail(400, "Bad request.");
  // Taken first: a challenge is spent by any attempt that names it.
  const challenge = takeChallenge(body.challengeId, party.rpId, "login");
  const response = body.response;
  if (!looksLikeCredential(response)) return fail(400, "Bad request.");
  const refused = fail<string>(401, "That passkey was not accepted here.");
  if (!challenge) {
    console.warn("[auth] passkey sign-in refused: unknown or spent challenge");
    return refused;
  }
  const stored = findPasskey(response.id);
  if (!stored || stored.rpId !== party.rpId) {
    console.warn(
      `[auth] passkey sign-in refused: ${stored ? "credential registered for another host" : "unknown credential"}`,
    );
    return refused;
  }
  try {
    const result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpId,
      expectedTopOrigin: topOriginOf(response.response.clientDataJSON as string),
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
        counter: stored.counter,
        transports: stored.transports,
      },
      requireUserVerification: false,
    });
    if (!result.verified) {
      console.warn("[auth] passkey sign-in refused: not verified");
      return refused;
    }
    touchPasskey(stored.id, result.authenticationInfo.newCounter);
    console.log(`[auth] passkey sign-in (${stored.id.slice(0, 8)}…, ${party.rpId})`);
    return { ok: true, value: stored.id };
  } catch (err) {
    console.warn(`[auth] passkey sign-in refused: ${errorLine(err)}`);
    return refused;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerOptions(
  party: Party,
): Promise<Outcome<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>> {
  if (listPasskeys().length >= MAX_PASSKEYS) return fail(409, "Too many passkeys; delete one first.");
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: party.rpId,
    // One user per server: every passkey is made for the same handle.
    userID: new Uint8Array(Buffer.from(passkeyUserId(), "base64url")),
    userName: "terminal-web",
    userDisplayName: "terminal-web",
    attestationType: "none",
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: listPasskeys()
      .filter((p) => p.rpId === party.rpId)
      .map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
  return {
    ok: true,
    value: { challengeId: putChallenge(options.challenge, party.rpId, "register"), options },
  };
}

/** A passkey name as given, made safe to store and show; empty when none is usable. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/** A default name from the browser's user agent. */
export function nameFromUserAgent(ua: string | undefined): string {
  const u = ua ?? "";
  if (/iPhone/.test(u)) return "iPhone";
  if (/iPad/.test(u)) return "iPad";
  if (/Android/.test(u)) return "Android";
  if (/CrOS/.test(u)) return "Chromebook";
  if (/Macintosh|Mac OS X/.test(u)) return "Mac";
  if (/Windows/.test(u)) return "Windows";
  if (/Linux/.test(u)) return "Linux";
  return "passkey";
}

export interface PasskeySummary {
  id: string;
  name: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Verify a registration and store the new passkey. */
export async function registerVerify(
  party: Party,
  body: unknown,
  userAgent: string | undefined,
): Promise<Outcome<PasskeySummary>> {
  if (!isObject(body)) return fail(400, "Bad request.");
  const challenge = takeChallenge(body.challengeId, party.rpId, "register");
  const response = body.response;
  if (!looksLikeCredential(response)) return fail(400, "Bad request.");
  if (body.name !== undefined && typeof body.name !== "string") return fail(400, "Bad name.");
  if (typeof body.name === "string" && body.name.length > 4 * MAX_NAME_LENGTH) {
    return fail(400, "Name too long.");
  }
  const refused = fail<PasskeySummary>(400, "The passkey could not be registered.");
  if (!challenge) {
    console.warn("[auth] passkey registration refused: unknown or spent challenge");
    return refused;
  }
  if (listPasskeys().length >= MAX_PASSKEYS) return fail(409, "Too many passkeys; delete one first.");
  try {
    const result = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpId,
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!result.verified) {
      console.warn("[auth] passkey registration refused: not verified");
      return refused;
    }
    const cred = result.registrationInfo.credential;
    if (findPasskey(cred.id)) return fail(409, "This passkey is already registered.");
    const passkey = {
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter,
      transports: (cred.transports ?? []).filter((t): t is string => typeof t === "string").slice(0, 8),
      rpId: party.rpId,
      name: cleanName(body.name) || nameFromUserAgent(userAgent),
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    addPasskey(passkey);
    console.log(
      `[auth] passkey registered (${passkey.id.slice(0, 8)}…, ${party.rpId}, ${JSON.stringify(passkey.name)})`,
    );
    return { ok: true, value: summarize(passkey) };
  } catch (err) {
    console.warn(`[auth] passkey registration refused: ${errorLine(err)}`);
    return refused;
  }
}

export function summarize(p: PasskeySummary): PasskeySummary {
  return { id: p.id, name: p.name, rpId: p.rpId, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt };
}

export function passkeySummaries(): PasskeySummary[] {
  return listPasskeys().map(summarize);
}
