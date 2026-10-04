#!/usr/bin/env node
// Background-work report — keeps the dashboard's idle nudge quiet while this
// session's background sub-agent or shell is really working (DX-3367). That work
// makes no MCP call, and the nudge's only other signal is the last MCP call time.
//
// Claude Code's Stop / SubagentStop input carries a `background_tasks` snapshot.
// This script reports a count from it via the recorded-version `danx-dashboard-mcp
// background-work <count|clear> <event-at>` subcommand (PUT /api/plan-sessions/me/background-work);
// the dashboard suppresses the nudge while a positive count is fresh. It injects
// nothing into the session.
//
// Modes (`process.argv[2]`, see `dispatchMode`):
//   stop / subagent-stop — count the snapshot, report it, and keep a local debug
//     record of what was counted (never a shell `command`).
//   session-start / stop-failure — report "clear" (no snapshot to trust).
//   heartbeat — PostToolUse(.*): only when `agent_id` shows a sub-agent running a
//     tool and the throttle has passed, re-report the count on record, at least 1
//     (DX-3676), so a long run — foreground or background — doesn't look idle. Compare-and-set, so a
//     slow re-report never overwrites a fresher Stop write.
//
// Every mode first checks `isPlanConnected` (lib/plan-connection.mjs) and does
// nothing for an unconnected session. A hook bug never fails a tool call or turn:
// main() swallows every error.
//
// Which package version runs (DX-4321): `session-start` refreshes the recorded
// `danx-dashboard-mcp` version from the registry (lib/dashboard-mcp-package.mjs) before it
// reports, and only for a plan-connected session (an unconnected one reports nothing, so it
// needs no package); every other mode reads the record with no registry request, resolving it
// only when none exists. This hook is async, so nothing reads its output: a refresh that fails still
// leaves its one line on stderr, and with no recorded version nothing is reported and the exit
// code is 1.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlanConnected, isValidSessionId } from "./lib/plan-connection.mjs";
import { requireRecordedSpec, versionFor } from "./lib/dashboard-mcp-package.mjs";
// The bridge's env builder: strips the session's inbox token/socket from the child env.
import { childEnv } from "./plan-event-bridge.mjs";

export { isValidSessionId, childEnv };

/** How long the subcommand's own hard timeout is documented to take; this script's spawn timeout sits a bit above it. */
export const REPORT_SPAWN_TIMEOUT_MS = 8_000;

/** Heartbeat no-op throttle — re-report at most this often per session. */
export const HEARTBEAT_THROTTLE_MS = 60_000;

/**
 * Every `background_tasks[].type` Claude Code documents (hooks docs, Stop input). A type
 * outside this set means a payload this script can't classify, so the whole snapshot
 * counts as unknown (`null`) rather than silently under-counting.
 */
const KNOWN_TASK_TYPES = new Set(["shell", "subagent", "monitor", "workflow", "teammate", "cloud session", "MCP task"]);

/** `background_tasks[].type` values that count as "still working" for the nudge's purposes. A monitor/teammate/cloud-session/MCP-task is a deliberate long-lived watcher, and counting it would silence the nudge forever. */
const COUNTED_TYPES = new Set(["shell", "subagent", "workflow"]);

/** The docs name no `status` enum; count only the one value they show, `"running"` (may under-count, never over-count). */
const RUNNING_STATUS = "running";

/** The debug record keeps each counted entry's description, truncated to this. */
const DESCRIPTION_MAX_LENGTH = 120;

/** `description`, truncated to `DESCRIPTION_MAX_LENGTH` — `undefined` (dropped by JSON.stringify) when absent or not a string, never coerced to a literal "undefined"/"null" string. */
function truncateDescription(description) {
  if (typeof description !== "string") return undefined;
  return description.length > DESCRIPTION_MAX_LENGTH ? description.slice(0, DESCRIPTION_MAX_LENGTH) : description;
}

/**
 * The entries `countFromSnapshot` actually counted, as `{id, type, status,
 * description}` — a NEW object per entry, so a shell entry's `command` never reaches
 * the debug file. `null` under the exact same
 * "unknown snapshot" rule as `countFromSnapshot`, so the two never disagree
 * about whether the snapshot was trustworthy.
 */
export function countedEntriesFromSnapshot(backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return null;
  if (backgroundTasks.some((task) => !KNOWN_TASK_TYPES.has(task?.type))) return null;
  return backgroundTasks
    .filter((task) => COUNTED_TYPES.has(task?.type) && task?.status === RUNNING_STATUS)
    .map((task) => {
      const entry = { id: task.id, type: task.type, status: task.status };
      const description = truncateDescription(task.description);
      if (description !== undefined) entry.description = description;
      return entry;
    });
}

/**
 * A small `{type: count}` map of entries `countFromSnapshot` skipped —
 * either because the type isn't a counted one (monitor/teammate/cloud
 * session/MCP task) or because a counted type wasn't `"running"`. Visible
 * alongside `counted` so an unexpected shape (e.g. everything skipped) shows
 * up in the debug file rather than just a flat, unexplained low count.
 * `null` under the same "unknown snapshot" rule as `countFromSnapshot`.
 */
export function ignoredTypesFromSnapshot(backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return null;
  if (backgroundTasks.some((task) => !KNOWN_TASK_TYPES.has(task?.type))) return null;
  const ignored = {};
  for (const task of backgroundTasks) {
    const isCounted = COUNTED_TYPES.has(task?.type) && task?.status === RUNNING_STATUS;
    if (!isCounted) ignored[task.type] = (ignored[task.type] ?? 0) + 1;
  }
  return ignored;
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

/** Read a file's exact bytes, or `null` if it does not exist / cannot be read — the compare token `runHeartbeat`'s compare-and-set write needs (see there). */
function readRawFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write `text` to `file` ONLY IF its current bytes still equal `expectedRaw`
 * — a compare-and-set for one JSON file with no lock. Returns whether the write happened.
 */
function compareAndSetFile(file, expectedRaw, text) {
  if (readRawFile(file) !== expectedRaw) return false;
  writeFileAtomic(file, text);
  return true;
}

/**
 * The count derived from a `background_tasks` snapshot.
 *
 * `null` ("unknown") when the field is absent, not an array, or contains ANY
 * entry whose `type` falls outside `KNOWN_TASK_TYPES` (including a missing
 * `type`) — an older or newer Claude Code build sending a shape this script
 * cannot fully classify, never guessed as `0`.
 * Otherwise, a real, trusted count of entries whose `type` is
 * shell/subagent/workflow AND whose `status` is exactly `"running"`
 * (RUNNING_STATUS) — including an empty array, or an array whose entries
 * are all known-but-not-counted, both legitimately `0`.
 */
export function countFromSnapshot(backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return null;
  if (backgroundTasks.some((task) => !KNOWN_TASK_TYPES.has(task?.type))) return null;
  return backgroundTasks.filter((task) => COUNTED_TYPES.has(task?.type) && task?.status === RUNNING_STATUS).length;
}

/**
 * The command that reports to the dashboard — never through a shell. On
 * Windows `npx` is a `.cmd` shim Node can't spawn directly, so run npm's own
 * JS entry with this node instead; elsewhere `npx` is an executable and is
 * spawned directly. Mirrors plan-event-bridge.mjs's `bridgeCommand`. `spec` is
 * `<name>@<recorded version>` (DX-4321), never a literal here.
 */
export function reportCommand({ countOrClear, eventAt, spec, platform = process.platform, execPath = process.execPath, exists = fs.existsSync }) {
  // DX-3676 — the hook's own event time rides every report; the dashboard keeps
  // only a report newer than the one it holds, so async hooks that finish out
  // of order cannot overwrite a newer count.
  const args = ["-y", spec, "background-work", countOrClear, eventAt];
  if (platform !== "win32") return { command: "npx", args };
  const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!exists(npxCli)) throw new Error(`npx not found: expected ${npxCli} next to ${execPath}`);
  return { command: execPath, args: [npxCli, ...args] };
}

/**
 * Parse the subcommand's ONE JSON stdout line into its `{ok, ...}` outcome
 * (see `packages/danx-dashboard-mcp/src/background-work.ts`'s own contract
 * doc: "print EXACTLY ONE JSON line on stdout, and ALWAYS exit 0"). Anything
 * that isn't that shape — no output, a spawn that never ran, malformed JSON
 * — is `{ok:false, reason:"..."}`, never treated as success.
 */
function parseSubcommandOutcome(result) {
  if (!result) return { ok: false, reason: "no_result" };
  if (result.error) return { ok: false, reason: `spawn_error: ${result.error.message}` };
  if (typeof result.stdout !== "string" || result.stdout.trim() === "") return { ok: false, reason: "no_output" };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: "unparseable_output" };
  }
  if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
  return { ok: false, reason: "unparseable_output" };
}

/**
 * Spawns the subcommand synchronously and returns its real `{ok, ...}`
 * outcome — never throws (a spawn failure becomes `{ok:false, reason}` too, so the
 * caller sees it). `stdio` pipes stdout so
 * the one JSON line the subcommand promises to print can be read; stdin is
 * ignored (nothing to send) and stderr is ignored (human diagnostics only,
 * per the subcommand's own contract doc).
 */
export function reportToDashboard({ countOrClear, eventAt, sessionId, env = process.env, spawnFn = spawnSync, platform, execPath, exists, timeoutMs = REPORT_SPAWN_TIMEOUT_MS }) {
  try {
    const { command, args } = reportCommand({ countOrClear, eventAt, spec: requireRecordedSpec(env), platform, execPath, exists });
    const result = spawnFn(command, args, {
      env: childEnv(env, sessionId),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
    });
    return parseSubcommandOutcome(result);
  } catch (err) {
    // A report failure is never fatal to the hook — see module docblock —
    // but it must still come back as a real outcome, not vanish silently.
    return { ok: false, reason: `spawn_threw: ${err.message}` };
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

/** Whether `sessionId` is currently plan-connected (`DANXBOT_PLAN_SESSIONS_HOME` overrides the home dir for tests). */
function sessionIsConnected(sessionId, env, isConnected) {
  return isConnected(sessionId, env?.DANXBOT_PLAN_SESSIONS_HOME || undefined);
}

/**
 * Fold one report attempt's outcome into the previous state. A report the dashboard STORED
 * (`outcome.ok && outcome.applied` — DX-3676: `applied:false` is an out-of-order report it
 * refused because a newer one was already on file) is the only thing
 * allowed to advance `count`/`reportedAt` — those two fields mean "the
 * dashboard has this count, as of this time", and a failed PUT never made
 * that true. A FAILED report still leaves evidence (`outcome` always
 * reflects the real `{ok, reason}` the subcommand returned) without lying
 * about what got stored: `count`/`reportedAt` fall back to whatever was
 * already on record (or `null` if there was never a successful report at
 * all) rather than advancing to the just-attempted, never-confirmed value.
 */
function nextReportState(previous, { count, counted, ignoredTypes, outcome, now }) {
  if (outcome.ok && outcome.applied) {
    return { count, counted: counted ?? null, ignoredTypes: ignoredTypes ?? null, reportedAt: new Date(now).toISOString(), outcome };
  }
  return {
    count: previous?.count ?? null,
    counted: previous?.counted ?? null,
    ignoredTypes: previous?.ignoredTypes ?? null,
    reportedAt: previous?.reportedAt ?? null,
    outcome,
  };
}

/** `stop` / `subagent-stop`: compute the count, report it, and persist the debug trail. */
export function runReport(input, { env, spawnFn, now, platform, execPath, exists, isConnected = isPlanConnected } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  if (!sessionIsConnected(sessionId, env, isConnected)) return; // never spawn for an unconnected session
  const backgroundTasks = input?.background_tasks;
  const count = countFromSnapshot(backgroundTasks);
  const counted = countedEntriesFromSnapshot(backgroundTasks);
  const ignoredTypes = ignoredTypesFromSnapshot(backgroundTasks);
  // DX-3676 — captured when the hook runs, BEFORE the (slow) report, so it orders this event.
  const nowMs = now ? now() : Date.now();
  const outcome = reportToDashboard({ countOrClear: countArg(count), eventAt: new Date(nowMs).toISOString(), sessionId, env, spawnFn, platform, execPath, exists });
  const dir = stateDir(env);
  const { state } = sessionPaths(dir, sessionId);
  const previous = readJsonFile(state);
  writeFileAtomic(state, JSON.stringify(nextReportState(previous, { count, counted, ignoredTypes, outcome, now: nowMs })));
}

/** `session-start` / `stop-failure`: no snapshot to trust — always clear, and drop the local record ONLY once the clear itself is confirmed. */
export function runClear(input, { env, spawnFn, now = Date.now, platform, execPath, exists, isConnected = isPlanConnected } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  if (!sessionIsConnected(sessionId, env, isConnected)) return;
  const eventAt = new Date(now()).toISOString(); // DX-3676 — a clear is ordered like any report
  const outcome = reportToDashboard({ countOrClear: "clear", eventAt, sessionId, env, spawnFn, platform, execPath, exists });
  const dir = stateDir(env);
  const { state } = sessionPaths(dir, sessionId);
  if (outcome.ok && outcome.applied) {
    fs.rmSync(state, { force: true });
    return;
  }
  // A failed clear — or one refused as older than a report already on file
  // (DX-3676) — keeps the last confirmed record and records the outcome.
  const previous = readJsonFile(state);
  writeFileAtomic(state, JSON.stringify(nextReportState(previous, { count: null, outcome })));
}

/**
 * `heartbeat`: a PostToolUse(`.*`) no-op almost always. Only acts when
 * `agent_id` proves a sub-agent is running a tool right now AND the throttle
 * window has elapsed. It re-reports the count on record, raised to at least 1
 * (DX-3676): that tool call is itself proof one sub-agent is working, even
 * when it runs in the foreground or started after a Stop that saw nothing
 * running — otherwise the dashboard's idle nudge fires while it builds.
 *
 * The throttle stamp is
 * claimed BEFORE the spawn (so a second tick starting while this one's
 * spawn is still in flight sees the throttle already claimed and no-ops),
 * and the state-file write AFTER the spawn is a compare-and-set against the
 * exact bytes read before the spawn started — if a fresher Stop/SubagentStop
 * write landed on the state file while this heartbeat's (synchronous, but
 * potentially slow) subcommand call was running, that fresher write is kept
 * and this tick's stale refresh is discarded rather than clobbering it.
 */
export function runHeartbeat(input, { env, spawnFn, now = Date.now, platform, execPath, exists, throttleMs = HEARTBEAT_THROTTLE_MS, isConnected = isPlanConnected } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  if (input?.agent_id === undefined || input?.agent_id === null) return;
  if (!sessionIsConnected(sessionId, env, isConnected)) return;

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

  const stateRaw = readRawFile(state);
  let stored = null;
  if (stateRaw !== null) {
    try {
      stored = JSON.parse(stateRaw);
    } catch {
      stored = null;
    }
  }
  // DX-3676 — this tool call proves at least one sub-agent is running.
  const count = Math.max(typeof stored?.count === "number" ? stored.count : 0, 1);

  // Claim the throttle stamp BEFORE spawning (see above).
  writeFileAtomic(heartbeat, JSON.stringify({ lastTickAt: new Date(nowMs).toISOString() }));
  try {
    fs.utimesSync(heartbeat, new Date(nowMs), new Date(nowMs));
  } catch {
    /* removed concurrently — nothing to touch */
  }

  const outcome = reportToDashboard({ countOrClear: countArg(count), eventAt: new Date(nowMs).toISOString(), sessionId, env, spawnFn, platform, execPath, exists });

  // Compare-and-set: only refresh `reportedAt` if the state file is still
  // exactly what it was before the spawn — a fresher write in the meantime
  // wins unconditionally.
  // The counted list carries forward unchanged: a heartbeat has no new snapshot.
  compareAndSetFile(
    state,
    stateRaw,
    JSON.stringify(nextReportState(stored, { count, counted: stored?.counted ?? null, ignoredTypes: stored?.ignoredTypes ?? null, outcome, now: nowMs })),
  );
}

/**
 * The routing table from a hook's `mode` argv string to the handler it
 * dispatches to — exported so mode routing is unit-tested without a spawned process. `hooks/hooks.json` is the
 * single source of which event sends which literal mode string; a test
 * parses that file directly rather than duplicating the strings here.
 */
export function dispatchMode(mode, input, options) {
  if (mode === "stop" || mode === "subagent-stop") return runReport(input, options);
  if (mode === "session-start" || mode === "stop-failure") return runClear(input, options);
  if (mode === "heartbeat") return runHeartbeat(input, options);
  return undefined; // unknown mode — silent no-op, matches the CLI-robustness contract
}

/**
 * DX-4321 — makes the recorded version ready for `mode`: `session-start` refreshes it, every other
 * mode reads it (resolving only when none exists). Returns the one line a failed refresh leaves
 * (the recorded version keeps running) or `null`; throws, with the one line saying nothing can
 * run, when there is no recorded version at all.
 */
export async function prepareVersion(mode, { env = process.env, versionForFn = versionFor } = {}) {
  const sessionStart = mode === "session-start";
  if (!sessionStart && !["stop", "subagent-stop", "stop-failure", "heartbeat"].includes(mode)) return null; // unknown mode: nothing to run
  return (await versionForFn({ sessionStart, env })).keptLine;
}

/** One hook firing: the version first, then the mode. Resolves to the one line to print (or `null`) and whether the version was missing. */
export async function runHook(mode, input, { env = process.env, versionForFn, ...options } = {}) {
  // A session that is not plan-connected reports nothing, so it needs no package: no registry request, no line.
  const isConnected = options.isConnected ?? isPlanConnected;
  if (!isValidSessionId(input?.session_id) || !sessionIsConnected(input.session_id, env, isConnected)) return { line: null, missingVersion: false };
  let line = null;
  try {
    line = await prepareVersion(mode, { env, versionForFn });
  } catch (err) {
    return { line: err.message, missingVersion: true };
  }
  dispatchMode(mode, input, { env, ...options });
  return { line, missingVersion: false };
}

async function main() {
  const mode = process.argv[2];
  const input = readStdinJson();
  if (!input) return; // malformed/empty stdin — never block or guess
  try {
    const { line, missingVersion } = await runHook(mode, input);
    if (line) process.stderr.write(`${line}\n`);
    if (missingVersion) process.exitCode = 1;
  } catch {
    // A hook bug must never surface as a failed/blocked tool call or turn.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
