/**
 * WebSocket control-message types shared by the terminal-web protocol.
 *
 * Only TEXT frames carry JSON control messages. BINARY frames are raw bytes
 * (user input client->server, pty output server->client) and have no type here.
 */

/** Client -> Server: request the pty/tmux to resize to the given dimensions. */
export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

/** Client -> Server: keep-alive request. Server replies with a PongMessage. */
export interface PingMessage {
  type: "ping";
}

/**
 * Client -> Server: kill this connection's tmux session so it restarts fresh.
 * The pty (tmux client) then exits, the ws closes, and the client reconnects
 * into a brand-new session via `new-session -A`.
 */
export interface RestartMessage {
  type: "restart";
}

/**
 * Client -> Server: kill this connection's tmux session for good (used when the
 * user closes the tab). Unlike restart, nothing is recreated.
 */
export interface KillMessage {
  type: "kill";
}

/** Server -> Client: reply to a PingMessage. */
export interface PongMessage {
  type: "pong";
}

/** Server -> Client: optional informational message. */
export interface InfoMessage {
  type: "info";
  message: string;
}

/**
 * Server -> Client: this session was closed (killed) — here or on another
 * device. The client drops the tab and does NOT reconnect (which would
 * otherwise recreate the session via `new-session -A`). This is what syncs a
 * tab close across devices in real time.
 */
export interface ClosedMessage {
  type: "closed";
}

/**
 * Client -> Server: diagnostic trace (only sent when ?debug=ime is set). The
 * server just logs these; they never affect terminal behavior.
 */
export interface DebugMessage {
  type: "debug";
  event: string;
  data?: string;
  at?: number;
}

/** Any JSON control message a client may send to the server. */
export type ClientMessage =
  | ResizeMessage
  | PingMessage
  | RestartMessage
  | KillMessage
  | DebugMessage;

/** Any JSON control message the server may send to a client. */
export type ServerMessage = PongMessage | InfoMessage | ClosedMessage;

/** Union of every JSON control message in the protocol. */
export type ControlMessage = ClientMessage | ServerMessage;

/** Narrowing type guard for parsed-but-untrusted client JSON. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "ping") return true;
  if (v.type === "restart") return true;
  if (v.type === "kill") return true;
  if (v.type === "debug") return typeof v.event === "string";
  if (v.type === "resize") {
    return typeof v.cols === "number" && typeof v.rows === "number";
  }
  return false;
}
