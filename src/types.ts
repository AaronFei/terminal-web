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

/** Server -> Client: reply to a PingMessage. */
export interface PongMessage {
  type: "pong";
}

/** Server -> Client: optional informational message. */
export interface InfoMessage {
  type: "info";
  message: string;
}

/** Any JSON control message a client may send to the server. */
export type ClientMessage = ResizeMessage | PingMessage;

/** Any JSON control message the server may send to a client. */
export type ServerMessage = PongMessage | InfoMessage;

/** Union of every JSON control message in the protocol. */
export type ControlMessage = ClientMessage | ServerMessage;

/** Narrowing type guard for parsed-but-untrusted client JSON. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "ping") return true;
  if (v.type === "resize") {
    return typeof v.cols === "number" && typeof v.rows === "number";
  }
  return false;
}
