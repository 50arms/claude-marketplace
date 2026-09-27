#!/usr/bin/env node
// Background-work report hook — danxbot plugin. DX-3367.
//
// WHY THIS EXISTS. A plan-connected session's idle-nudge ("this session has
// been idle N minutes with work waiting") fires even when the session's own
// background sub-agent or background shell is actively working, because that
// work makes no MCP call while it runs — the nudge's only signal is
// `plan_sessions.last_agent_call_at`, stamped only by a real MCP call.
//
// Claude Code's `Stop` / `SubagentStop` hooks carry a `background_tasks`
// snapshot (`[{id, type, status, description}]`) describing in-flight
// background work in the session. This script reports a COUNT derived from
// that snapshot to the dashboard via the published
// `@thehammer/danx-dashboard-mcp background-work <count|clear>` subcommand,
// which `PUT`s `/api/plan-sessions/me/background-work` — the dashboard's
// `evaluateIdleNudge` reads it to suppress the nudge while a positive count
// is fresh (within a 60-minute ceiling, dashboard-side).
//
// Five modes, driven by `process.argv[2]`:
//   stop / subagent-stop — read `input.background_tasks`, compute a count
//     (see `countFromSnapshot`), report it, and persist `{count, reportedAt}`
//     to this session's local state file (the heartbeat mode's refresh
//     source, and a human-readable debug trail of what was last reported).
//   session-start / stop-failure — always report "clear" (no snapshot to
//     trust — a fresh session, or one that just hit an API error) and drop
//     the local state file.
//   heartbeat — a PostToolUse(`.*`) no-op almost always. Only acts when
//     `input.agent_id` is present (this tool call belongs to a background
//     sub-agent, i.e. one is still alive) AND the per-session throttle stamp
//     is at least HEARTBEAT_THROTTLE_MS old — mirrors
//     plan-event-bridge.mjs's `watchdogTick` mtime-throttle idiom, a
//     separate stamp file rather than a timer. When due, it RE-reports the
//     count already on record (refreshing the server's
//     `background_reported_at` so a long-running sub-agent's positive report
//     doesn't cross the ceiling while genuinely still running) — never
//     invents a count, and does nothing when none is on record.
//
// A hook script bug must never surface as a failed/blocked tool call or
// turn — every mode body runs inside main()'s top-level try/catch, mirroring
// plan-tab-watch.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The ONE place a future version bump changes (mirrors plan-event-bridge.mjs's own constant). */
export const DASHBOARD_MCP_PACKAGE = "@thehammer/danx-dashboard-mcp@0.1.136";

/** How long the subcommand's own hard timeout is documented to take; this script's spawn timeout sits a bit above it. */
export const REPORT_SPAWN_TIMEOUT_MS = 8_000;

/** Heartbeat no-op throttle — re-report at most this often per session. */
export const HEARTBEAT_THROTTLE_MS = 60_000;

/** `background_tasks[].type` values that count as "still working" for the nudge's purposes. A monitor/teammate/cloud-session/MCP-task is a deliberate long-lived watcher, not transient work — counting it would silence the nudge forever. */
const COUNTED_TYPES = new Set(["shell", "subagent", "workflow"]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Whether `sessionId` is safe to use as a path segment (same idiom as plan-tab-watch.mjs's isValidSessionId). */
export function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

/** `${CLAUDE_PLUGIN_DATA}/background-work/` — a new state dir, sibling to plan-event-bridge.mjs's own `stateDir()`. */
export function stateDir(env = process.env) {
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error("CLAUDE_PLUGIN_DATA is not set — this script only runs from the danxbot plugin's hooks");
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, "background-work");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The session's two state files: the last-reported count, and the heartbeat throttle stamp. */
export function sessionPaths(dir, sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error("session id is missing or has unexpected characters");
  }
  const base = path.join(dir, sessionId);
  return {
    state: `${base}.json`,
    heartbeat: `${base}.heartbeat.json`,
  };
}

/** Write-then-rename: a reader sees the old file or the new one, never a torn write (same idiom as plan-event-bridge.mjs's writeFileAtomic). */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The count derived from a `background_tasks` snapshot.
 *
 * `null` ("unknown") when the field is absent — an older Claude Code build
 * that doesn't send it, or a malformed payload — NEVER guessed as `0`.
 * Otherwise the number of entries whose `type` is shell/subagent/workflow,
 * including an empty array (a real, trusted "zero background work" answer).
 */
export function countFromSnapshot(backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return null;
  return backgroundTasks.filter((task) => COUNTED_TYPES.has(task?.type)).length;
}

/** The dashboard subcommand's environment: the session id it needs, nothing else added or removed (mirrors plan-event-bridge.mjs's childEnv). */
export function childEnv(env, sessionId) {
  return { ...env, CLAUDE_CODE_SESSION_ID: sessionId };
}

/**
 * The command that reports to the dashboard — never through a shell. On
 * Windows `npx` is a `.cmd` shim Node can't spawn directly, so run npm's own
 * JS entry with this node instead; elsewhere `npx` is an executable and is
 * spawned directly. Mirrors plan-event-bridge.mjs's `bridgeCommand`.
 */
export function reportCommand({ countOrClear, platform = process.platform, execPath = process.execPath, exists = fs.existsSync }) {
  const args = ["-y", DASHBOARD_MCP_PACKAGE, "background-work", countOrClear];
  if (platform !== "win32") return { command: "npx", args };
  const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!exists(npxCli)) throw new Error(`npx not found: expected ${npxCli} next to ${execPath}`);
  return { command: execPath, args: [npxCli, ...args] };
}

/**
 * Spawns the subcommand synchronously and ignores its outcome entirely — it
 * always exits 0 within its own ~5s hard timeout and prints one `{ok,...}`
 * JSON line this script has no need to parse. A spawn failure (missing npx,
 * timeout, non-zero exit) must never throw out of this script.
 */
export function reportToDashboard({ countOrClear, sessionId, env = process.env, spawnFn = spawnSync, platform, execPath, exists, timeoutMs = REPORT_SPAWN_TIMEOUT_MS }) {
  try {
    const { command, args } = reportCommand({ countOrClear, platform, execPath, exists });
    spawnFn(command, args, { env: childEnv(env, sessionId), stdio: "ignore", timeout: timeoutMs, windowsHide: true });
  } catch {
    // A report failure is never fatal to the hook — see module docblock.
  }
}

/** `count-or-"clear"` as the literal argv string the subcommand expects. */
function countArg(count) {
  return count === null ? "clear" : String(count);
}

function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** `stop` / `subagent-stop`: compute the count, report it, and persist the debug trail. */
export function runReport(input, { env, spawnFn, now, platform, execPath, exists } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  const count = countFromSnapshot(input?.background_tasks);
  reportToDashboard({ countOrClear: countArg(count), sessionId, env, spawnFn, platform, execPath, exists });
  const dir = stateDir(env);
  const { state } = sessionPaths(dir, sessionId);
  writeFileAtomic(state, JSON.stringify({ count, reportedAt: new Date(now ? now() : Date.now()).toISOString() }));
}

/** `session-start` / `stop-failure`: no snapshot to trust — always clear, and drop the local record. */
export function runClear(input, { env, spawnFn, platform, execPath, exists } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  reportToDashboard({ countOrClear: "clear", sessionId, env, spawnFn, platform, execPath, exists });
  const dir = stateDir(env);
  const { state } = sessionPaths(dir, sessionId);
  fs.rmSync(state, { force: true });
}

/**
 * `heartbeat`: a PostToolUse(`.*`) no-op almost always. Only acts when
 * `agent_id` proves a background sub-agent is alive AND the throttle window
 * has elapsed, and only ever RE-reports a count already on record.
 */
export function runHeartbeat(input, { env, spawnFn, now = Date.now, platform, execPath, exists, throttleMs = HEARTBEAT_THROTTLE_MS } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  if (input?.agent_id === undefined || input?.agent_id === null) return;

  const dir = stateDir(env);
  const { state, heartbeat } = sessionPaths(dir, sessionId);
  const nowMs = now();
  let throttleAge = Infinity;
  try {
    throttleAge = nowMs - fs.statSync(heartbeat).mtimeMs;
  } catch {
    /* never ticked before — a fresh tick is due */
  }
  if (throttleAge < throttleMs) return;

  const stored = readJsonFile(state);
  if (typeof stored?.count !== "number") return; // nothing honest to refresh

  reportToDashboard({ countOrClear: countArg(stored.count), sessionId, env, spawnFn, platform, execPath, exists });
  writeFileAtomic(state, JSON.stringify({ count: stored.count, reportedAt: new Date(nowMs).toISOString() }));
  writeFileAtomic(heartbeat, JSON.stringify({ lastTickAt: new Date(nowMs).toISOString() }));
  // DX-3367 (mirrors plan-event-bridge.mjs's watchdogTick): stamp the
  // throttle file's own mtime to the INJECTED `now`, not whatever the real
  // OS clock was at write time — the throttle compare above is against this
  // same injected `now()`, so it must be too, for a deterministic test clock.
  try {
    fs.utimesSync(heartbeat, new Date(nowMs), new Date(nowMs));
  } catch {
    /* removed concurrently — nothing to touch */
  }
}

function main() {
  const mode = process.argv[2];
  const input = readStdinJson();
  if (!input) return; // malformed/empty stdin — never block or guess
  const env = process.env;
  try {
    if (mode === "stop" || mode === "subagent-stop") runReport(input, { env });
    else if (mode === "session-start" || mode === "stop-failure") runClear(input, { env });
    else if (mode === "heartbeat") runHeartbeat(input, { env });
  } catch {
    // A hook bug must never surface as a failed/blocked tool call or turn.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
