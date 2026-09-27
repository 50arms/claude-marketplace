#!/usr/bin/env node
// Shared plan-connection detection — danxbot plugin. DX-3275.
//
// WHY THIS EXISTS. Plan rule R-10 (PLN-11): the danxbot plugin stays quiet
// until a session is actually connected to a danxbot plan. Three consumers
// need the identical yes/no answer to "is THIS session connected right now":
// `mantra.sh` (SessionStart — full mantra vs. the plan-workflow nudge),
// `plan-workflow-autoload.sh` (SessionStart — full skill body vs. silence),
// and `plan-connect-mantra.mjs` (PostToolUse on plan_connect — surface the
// mantra the instant a connect succeeds). This module is the ONE place that
// answer is computed, so all three read the same detection instead of each
// growing its own copy that can drift.
//
// THE DETECTION ITSELF IS NOT NEW. `plan-tab-watch.mjs` already documented
// it (DX-2995): a successful `plan_connect` MCP call writes
// `~/.config/danxbot/plan-sessions/<session-id>.json`, owned by
// `packages/danx-dashboard-mcp`'s `session-connection.ts` (danxbot repo,
// `sessionConnectionPath`) — see that file for the exact schema. This module
// only checks the record's PRESENCE (a local file stat, no network call per
// turn, per R-12/AC 35059) — it never reads or interprets the record's
// contents, which belong entirely to the MCP package.
//
// Session id validation mirrors `plan-tab-watch.mjs`'s `isValidSessionId` —
// duplicated rather than imported (plugins never import another plugin's or
// package's source).

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
 * stat only, never a dashboard call. `home` defaults to the real home dir;
 * tests override it (matches `plan-tab-watch.mjs`'s
 * `DANXBOT_PLAN_TAB_WATCH_HOME` convention) via `DANXBOT_PLAN_SESSIONS_HOME`.
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
