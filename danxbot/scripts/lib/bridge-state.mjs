/**
 * The plan event bridge's per-session state-file plumbing, shared by
 * `plan-event-bridge.mjs` (which writes the files) and `bridge-watchdog.mjs`
 * (which reads them to decide whether the bridge needs a restart).
 *
 * DX-3997: lives outside `plan-event-bridge.mjs` so the watchdog can read the
 * state without importing the bridge — a corrupted bridge file must not take
 * the code that restarts it down with it. This module imports only `node:`
 * built-ins, so the watchdog's dependency set stays tiny and checkable.
 *
 * STATE lives under `${CLAUDE_PLUGIN_DATA}/plan-event-bridge/`, per session.
 */

import fs from "node:fs";
import path from "node:path";

/** A bridge whose heartbeat is older than this is stale (its holder may be dead). */
export const HEARTBEAT_STALE_MS = 90_000;
/** A subcommand that ran this long before dying without a stop record is restarted; a quicker death is terminal. */
export const HEALTHY_RUN_MS = 60_000;
/**
 * DX-2953 — the watchdog's own tick cadence: how often a PostToolUse/Stop
 * hook invocation actually DOES anything, throttled by a timestamp file
 * (`sessionPaths(...).watchdog`). Every tick in between is a no-op file stat.
 */
export const WATCHDOG_THROTTLE_MS = 60_000;

export function stateDir(env = process.env) {
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error("CLAUDE_PLUGIN_DATA is not set — the bridge only runs from the danxbot plugin's hooks");
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, "plan-event-bridge");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The session's state files. A missing or odd session id is refused, never turned into a path. */
export function sessionPaths(dir, sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("session id is missing or has unexpected characters");
  }
  const base = path.join(dir, sessionId);
  return {
    pid: `${base}.pid.json`,
    lock: `${base}.lock`,
    cursor: `${base}.cursor.json`,
    log: `${base}.log`,
    // DX-3028: the MCP child's stopped record, read by the watchdog.
    stopped: `${base}.stopped.json`,
    // DX-2953: split into two single-writer files (started by start(), connected by
    // the run process) so a start racing the previous child's ready write can't lose a field.
    started: `${base}.started.json`,
    connected: `${base}.connected.json`,
    // DX-2953: watchdog throttle stamp — mtime IS its content; also refreshes the
    // marker files' mtimes so pruneStale never reclaims a live session.
    watchdog: `${base}.watchdog.json`,
  };
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write-then-rename: a reader sees the old file or the new one, never a torn write. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
