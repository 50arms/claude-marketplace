#!/usr/bin/env node
// Activity report — tells the dashboard what a plan-connected session is RUNNING, so its
// "running" count closes when a sub-agent finishes (DX-3284). Without this the dashboard only
// learns of a sub-agent when its transcript file appears and never that it finished.
//
// Three hooks, ALL registered `async: true` (hooks/hooks.json), so none ever delays a tool call
// or a sub-agent. The documented behavior of an async hook: Claude Code spawns it and moves on,
// reading neither its exit code nor its stdout. So this script can never report a failure through
// either: it is self-contained, swallows its own errors, and always exits 0. A failure leaves one
// small trace file (below) instead. `asyncRewake` is deliberately NOT used: a hook measuring a
// session must never interrupt it.
//
//   subagent-start   SubagentStart (matcher .*)       a sub-agent began
//   subagent-stop    SubagentStop                     a sub-agent finished
//   background-bash  PostToolUse (matcher Bash)       a Bash call with run_in_background: true began
//
// There is NO hook event for a background Bash command FINISHING (none of Claude Code's documented
// events fires on it; TaskCreated/TaskCompleted are the TaskCreate tool, not a shell). So a
// background script gets a start and no end from here: the dashboard closes it when the
// dispatch ends. Do not add a proxy event for it.
//
// What each event MEANS (the row key, the sub-agent id, the timestamps) lives in the
// package's `activity` subcommand, not here. This script decides only WHETHER to call it:
//   - only for a session connected to a plan (lib/plan-connection.mjs), like every other hook
//     that talks to the dashboard;
//   - for PostToolUse, only a background Bash call. PostToolUse(Bash) fires for EVERY Bash call;
//     the subcommand refuses a foreground one itself, but starting the package for each would
//     cost a process per command, so this is the one place the same predicate is read early.
//
// How it runs the package (DX-3811): the INSTALLED copy of the recorded version (DX-4321: read from
// the plugin's record, resolved only when none exists), with plain `node`, via
// ensure-dashboard-mcp.sh (a file check once installed) — never a cold `npx -y`, which was
// measured failing 29 of 40 under concurrent sub-agent starts.
//
// The event time is captured the moment this hook runs, before the install check and the
// spawn, and passed to the subcommand: the dashboard orders by it, and a cold install can take
// tens of seconds.
//
// Failure trace: `${CLAUDE_PLUGIN_DATA}/activity/<session>.last-failure.json` holds the most
// recent failed report ({at, mode, reason}); a success never writes. It is the only way a
// failure here is ever visible. It is written with the bridge's `writeFileAtomic` and pruned
// with the bridge's `pruneStale` (7 days; `.last-failure.json` is in its STATE_SUFFIXES).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlanConnected, isValidSessionId } from "./lib/plan-connection.mjs";
import { childEnv, pruneStale } from "./plan-event-bridge.mjs";
import { writeFileAtomic } from "./lib/bridge-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The package subcommand this script runs. */
export const ACTIVITY_SUBCOMMAND = "activity";

/** The Claude Code hook event each mode is registered under, as the subcommand names it. */
export const MODE_EVENTS = {
  "subagent-start": "SubagentStart",
  "subagent-stop": "SubagentStop",
  "background-bash": "PostToolUse",
};

/** Bounds the report; the subcommand's own fetch timeout is 5 s and the package starts in well under a second. */
export const REPORT_SPAWN_TIMEOUT_MS = 12_000;

/**
 * Bounds the install check, which on a cold first call is a real `npm install`. ensure-dashboard-mcp.sh
 * bounds that install at its own INSTALL_TIMEOUT_SECS (60 s); this sits 5 s above it, so the script's
 * own `timeout:` verdict is the one reported, never this spawn's kill.
 */
export const ENSURE_SPAWN_TIMEOUT_MS = 65_000;

/**
 * Whether a PostToolUse payload is a Bash call that was started in the background. The
 * subcommand makes the same decision authoritatively; this is the early read of it that keeps a
 * foreground Bash call from starting a node process (see the header).
 */
export function isBackgroundBash(input) {
  return input?.tool_name === "Bash" && input?.tool_input?.run_in_background === true;
}

/** `${CLAUDE_PLUGIN_DATA}/activity/` — the failure-trace directory. */
export function stateDir(env = process.env) {
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error("CLAUDE_PLUGIN_DATA is not set — this script only runs from the danxbot plugin's hooks");
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, "activity");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function failureFile(dir, sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error("session id is missing or has unexpected characters");
  return path.join(dir, `${sessionId}.last-failure.json`);
}

/**
 * The installed package's entry point, via ensure-dashboard-mcp.sh. `{ok:true, bin}` or
 * `{ok:false, reason}` — the script prints one line naming its reason on failure.
 */
export function ensureInstalled({ env = process.env, spawnFn = spawnSync, timeoutMs = ENSURE_SPAWN_TIMEOUT_MS } = {}) {
  const result = spawnFn("bash", [path.join(here, "ensure-dashboard-mcp.sh")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result?.error) return { ok: false, reason: `ensure_spawn_error: ${result.error.message}` };
  if (result?.status !== 0 || typeof result.stdout !== "string" || result.stdout.trim() === "") {
    const detail = typeof result?.stderr === "string" ? result.stderr.trim().split("\n").at(-1) : "";
    return { ok: false, reason: `ensure_failed: ${detail || `exit ${result?.status}`}` };
  }
  return { ok: true, bin: result.stdout.trim() };
}

/**
 * Parse the subcommand's ONE JSON stdout line ("print EXACTLY ONE JSON line on stdout, and
 * ALWAYS exit 0" — packages/danx-dashboard-mcp/src/activity.ts). Anything else is a failure,
 * never read as success.
 */
export function parseOutcome(result) {
  if (!result) return { ok: false, reason: "no_result" };
  if (result.error) return { ok: false, reason: `spawn_error: ${result.error.message}` };
  if (typeof result.stdout !== "string" || result.stdout.trim() === "") return { ok: false, reason: "no_output" };
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
  } catch {
    /* fall through */
  }
  return { ok: false, reason: "unparseable_output" };
}

/**
 * Failures that are the ORDINARY, expected answer rather than a fault, so they leave no trace:
 * the session is not on a plan (no connection record, or the dashboard says so), or it is a
 * worker's session id. Everything else — a refused envelope, an unreachable dashboard, a bad
 * credential — is a real failure.
 */
const EXPECTED_REASONS = new Set(["no_connection_record", "credential_unavailable", "session_not_connected", "session_is_worker"]);

function recordFailure(env, sessionId, mode, outcome, now) {
  const file = failureFile(stateDir(env), sessionId);
  // The bridge's own writer: a unique tmp name, so two hooks failing at once never share one.
  writeFileAtomic(file, JSON.stringify({ at: new Date(now).toISOString(), mode, reason: outcome.reason }));
}

/**
 * One hook firing. Returns the outcome (or `null` when it deliberately did nothing) so tests
 * can read it; the CLI ignores it.
 */
export function runActivity(mode, rawPayload, { env = process.env, spawnFn = spawnSync, ensureFn = ensureInstalled, now = Date.now, isConnected = isPlanConnected } = {}) {
  const event = MODE_EVENTS[mode];
  if (event === undefined) return null;
  // Captured FIRST: before the install check, the connection read and the spawn.
  const eventAtMs = now();

  let input;
  try {
    input = JSON.parse(rawPayload);
  } catch {
    return null; // malformed/empty stdin — never block or guess
  }
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return null;
  if (mode === "background-bash" && !isBackgroundBash(input)) return null; // before any file read: this fires for every Bash call
  if (!isConnected(sessionId, env.DANXBOT_PLAN_SESSIONS_HOME || undefined)) return null; // never spawn for an unconnected session

  // The bridge's own pruning (a trace nothing has touched for a week goes), run on every report
  // rather than only a failing one, so a clean stretch cannot leave old traces behind forever.
  pruneStale(stateDir(env), eventAtMs);

  const record = (outcome) => {
    if (!outcome.ok && !EXPECTED_REASONS.has(outcome.reason)) recordFailure(env, sessionId, mode, outcome, eventAtMs);
    return outcome;
  };

  const ensured = ensureFn({ env });
  if (!ensured.ok) return record(ensured);

  const result = spawnFn(process.execPath, [ensured.bin, ACTIVITY_SUBCOMMAND, event, new Date(eventAtMs).toISOString()], {
    env: childEnv(env, sessionId),
    input: rawPayload,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: REPORT_SPAWN_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8",
  });
  return record(parseOutcome(result));
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  try {
    runActivity(process.argv[2], readStdin());
  } catch {
    // A hook bug must never surface as a failed or blocked tool call, sub-agent or turn.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
