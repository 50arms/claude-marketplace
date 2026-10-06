// Is this session connected to a danxbot plan? The ONE answer (PLN-11 R-10: the
// plugin stays quiet until a plan is connected), shared by
// activity-report.mjs, background-work-report.mjs and ready-cards-stop.mjs (DX-4391).
// A successful `plan_connect` makes the
// danx-dashboard MCP server write `~/.config/danxbot/plan-sessions/<session>.json`
// (its `session-connection.ts` owns the schema); this only checks the file
// exists. A local stat, never a network call.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Whether `sessionId` is safe to use as a path segment. */
export function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

/** Where this session's connection record would live, given `home`. */
export function sessionConnectionPath(sessionId, home = homedir()) {
  return join(home, ".config", "danxbot", "plan-sessions", `${sessionId}.json`);
}

/**
 * Whether `sessionId` currently has a live plan connection — a local file
 * stat only. `home` defaults to the real home dir; tests override it via
 * `DANXBOT_PLAN_SESSIONS_HOME`.
 */
export function isPlanConnected(sessionId, home = homedir()) {
  if (!isValidSessionId(sessionId)) return false;
  try {
    return existsSync(sessionConnectionPath(sessionId, home));
  } catch {
    return false; // never let a stat error read as "connected"
  }
}
