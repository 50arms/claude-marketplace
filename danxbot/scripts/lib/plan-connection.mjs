#!/usr/bin/env node
// Is this session connected to a danxbot plan? The ONE answer (PLN-11 R-10: the
// plugin stays quiet until a plan is connected), shared by mantra.sh,
// plan-workflow-autoload.sh, background-work-report.mjs and the plan event
// bridge's SessionStart start. A successful `plan_connect` makes the
// danx-dashboard MCP server write `~/.config/danxbot/plan-sessions/<session>.json`
// (its `session-connection.ts` owns the schema); this only checks the file
// exists. A local stat, never a network call.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/**
 * CLI mode for bash consumers (`mantra.sh`, `plan-workflow-autoload.sh`):
 * reads the hook's stdin JSON, falls back to `CLAUDE_CODE_SESSION_ID` when
 * stdin carries no `session_id` (mirrors `plan-event-bridge.mjs`'s
 * `readHookInput` fallback), and prints exactly `1` or `0` — nothing else,
 * so `$(...)` capture in bash needs no parsing.
 */
function main() {
  const input = readStdinJson();
  const sessionId =
    (typeof input?.session_id === "string" && input.session_id !== "" ? input.session_id : null) ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    null;
  const home = process.env.DANXBOT_PLAN_SESSIONS_HOME || homedir();
  process.stdout.write(isPlanConnected(sessionId, home) ? "1" : "0");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
