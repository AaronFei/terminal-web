import os from "node:os";
import path from "node:path";

// Where this server keeps its own files (tabs.json, closed.json, prefs.json,
// auth-sessions.json, passkeys.json). ~/.terminal-web for the main instance;
// a TERMINAL_WEB_INSTANCE gets its own (config.stateDir). Set once at startup,
// before anything reads or writes one of those files.
let dir = path.join(os.homedir(), ".terminal-web");

export function setStateDir(d: string): void {
  dir = d;
}
export function stateDir(): string {
  return dir;
}
