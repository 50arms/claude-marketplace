#!/usr/bin/env node
// Background-work report hook — danxbot plugin. DX-3367 (+ review fix-up).
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
// Five modes, driven by `process.argv[2]` (see `dispatchMode`):
//   stop / subagent-stop — read `input.background_tasks`, compute a count
//     (see `countFromSnapshot`), report it, and persist `{count, counted,
//     ignoredTypes, reportedAt, outcome}` to this session's local state file
//     (the heartbeat mode's refresh source, and a human-readable debug trail
//     of what was last reported — see `nextReportState` for why a FAILED
//     report never advances `count`/`counted`/`ignoredTypes`/`reportedAt`).
//     `counted` (DX-3367 comment 7171) is the COUNTED entries themselves —
//     `{id, type, status, description}`, description truncated, `command`
//     never included — so a stuck count is debuggable: which task is still
//     being counted, not just how many. `ignoredTypes` is a small
//     `{type: count}` map of entries skipped by type or status, so an
//     unexpected snapshot shape is visible too.
//   session-start / stop-failure — always report "clear" (no snapshot to
//     trust — a fresh session, or one that just hit an API error) and drop
//     the local state file, UNLESS the clear itself fails (see `runClear`).
//   heartbeat — a PostToolUse(`.*`) no-op almost always. Only acts when
//     `input.agent_id` is present (this tool call belongs to a background
//     sub-agent, i.e. one is still alive) AND the per-session throttle stamp
//     is at least HEARTBEAT_THROTTLE_MS old — mirrors
//     plan-event-bridge.mjs's `watchdogTick` mtime-throttle idiom, a
//     separate stamp file rather than a timer. When due, it RE-reports the
//     count already on record (refreshing the server's
//     `background_reported_at` so a long-running sub-agent's positive report
//     doesn't cross the ceiling while genuinely still running) — never
//     invents a count, and does nothing when none is on record. The throttle
//     stamp is claimed BEFORE the spawn and the state file write is a
//     compare-and-set AFTER it (see `runHeartbeat`) — DX-3367 review finding
//     5: a slow heartbeat spawn must never let a stale re-report clobber a
//     fresher Stop/SubagentStop write that landed while it was in flight.
//
// PLAN-CONNECTION GATE (DX-3367 review finding 1). Every mode checks
// `isPlanConnected` (shared with `plan-connect-mantra.mjs` /
// `plan-workflow-autoload.mjs` via `lib/plan-connection.mjs`) BEFORE doing
// anything else — in particular before any spawn. This plugin loads in
// EVERY Claude Code session on this machine, most of which never touch a
// danxbot plan; a session that was never `plan_connect`-ed has no
// `plan_sessions` row for this feature to suppress a nudge on, so reporting
// for it is pure cost (an `npx -y` spawn, a local state-dir mkdir) with zero
// effect. `isValidSessionId` is likewise imported from that same module
// rather than re-implemented, so the two checks can never drift apart.
//
// A hook script bug must never surface as a failed/blocked tool call or
// turn — every mode body runs inside main()'s top-level try/catch, mirroring
// plan-tab-watch.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlanConnected, isValidSessionId } from "./lib/plan-connection.mjs";
// DX-3367 review finding 6: reuse the bridge's own env builder (strips the
// session's messaging-inbox token/socket before handing the env to a
// subcommand that has no business reading them) rather than a second,
// driftable copy of the same logic.
import { childEnv } from "./plan-event-bridge.mjs";

export { isValidSessionId, childEnv };

/**
 * The ONE place THIS script's MCP package pin changes.
 *
 * DX-3367 review finding 7: `plan-event-bridge.mjs` pins its OWN
 * `DASHBOARD_MCP_PACKAGE` independently (currently 0.1.95), and the two are
 * NOT the same constant on purpose, not by oversight. `bridge.ts` /
 * `listen.ts` (the subcommands the bridge pins) picked up real behavior
 * changes after 0.1.95 — DX-3274, DX-3099, DX-3028 all touched one or both
 * files on `origin/main` since that version — so bumping the bridge's pin to
 * match this one is a SEPARATE change that needs its own verification the
 * bridge still behaves identically at the new version; it is not safe to do
 * as a side effect of this fix-up, and the card this comment lives on
 * explicitly says to leave it alone rather than guess. If a future change
 * proves the two subcommands' contracts move together, unify them then —
 * until it does, two independent pins is the correct (not merely
 * expedient) state, not something to "fix".
 */
export const DASHBOARD_MCP_PACKAGE = "@thehammer/danx-dashboard-mcp@0.1.136";

/** How long the subcommand's own hard timeout is documented to take; this script's spawn timeout sits a bit above it. */
export const REPORT_SPAWN_TIMEOUT_MS = 8_000;

/** Heartbeat no-op throttle — re-report at most this often per session. */
export const HEARTBEAT_THROTTLE_MS = 60_000;

/**
 * The FULL set of `background_tasks[].type` values Claude Code documents
 * (https://code.claude.com/docs/en/hooks.md, Stop input, "Each entry in
 * background_tasks..."): "Friendly task-type label such as `shell`,
 * `subagent`, `monitor`, `workflow`, `teammate`, `cloud session`, or `MCP
 * task`. ... Falls back to the raw discriminant for unrecognized types."
 * An entry whose `type` is OUTSIDE this set (or missing/null) means either a
 * malformed payload or a Claude Code build that has grown a type this
 * script has never seen — `countFromSnapshot` treats the WHOLE snapshot as
 * unknown (`null`) rather than silently under-counting one entry, per
 * DX-3367 review finding 4.
 */
const KNOWN_TASK_TYPES = new Set(["shell", "subagent", "monitor", "workflow", "teammate", "cloud session", "MCP task"]);

/** `background_tasks[].type` values that count as "still working" for the nudge's purposes. A monitor/teammate/cloud-session/MCP-task is a deliberate long-lived watcher, and counting it would silence the nudge forever. */
const COUNTED_TYPES = new Set(["shell", "subagent", "workflow"]);

/**
 * DX-3367 review finding 4: the SAME docs page documents `status` only as
 * "Current task status" — no enumerated value list anywhere on the page.
 * The single worked example shows `"status": "running"`. Rather than assume
 * some other unseen value (`"pending"`, `"backgrounded"`, ...) also means
 * "still working", this counts ONLY the literal string the docs actually
 * demonstrate. That is a deliberately conservative (can under-count, never
 * over-count) reading — "never assume" cuts against guessing a broader
 * enum just as much as against guessing a narrower one.
 */
const RUNNING_STATUS = "running";

/**
 * DX-3367 comment 7171: the debug file recorded only a COUNT, which could
 * not answer "which task is being counted" — exactly the question that
 * surfaced a still-`running` entry in production 60 minutes after every
 * sub-agent this session dispatched had actually finished. `runReport`
 * persists the COUNTED entries themselves alongside the count, so the next
 * report shows exactly what is being counted.
 *
 * Truncated to keep the debug file small; ~120 chars is enough to identify
 * a task, not enough to be a transcript.
 */
const DESCRIPTION_MAX_LENGTH = 120;

/** `description`, truncated to `DESCRIPTION_MAX_LENGTH` — `undefined` (dropped by JSON.stringify) when absent or not a string, never coerced to a literal "undefined"/"null" string. */
function truncateDescription(description) {
  if (typeof description !== "string") return undefined;
  return description.length > DESCRIPTION_MAX_LENGTH ? description.slice(0, DESCRIPTION_MAX_LENGTH) : description;
}

/**
 * The entries `countFromSnapshot` actually counted, as `{id, type, status,
 * description}` — built as a NEW object per entry (never spread from the
 * source task), so a `command` field a shell entry carries (DX-3367 review
 * finding: never write anything secret) can never reach the debug file no
 * matter what Claude Code's snapshot contains. `null` under the exact same
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
 * — a poor-man's compare-and-set for a single JSON file with no external
 * lock (DX-3367 review finding 5). Returns whether the write happened.
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
 * cannot fully classify, never guessed as `0` (DX-3367 review finding 4).
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
 * Parse the subcommand's ONE JSON stdout line into its `{ok, ...}` outcome
 * (see `packages/danx-dashboard-mcp/src/background-work.ts`'s own contract
 * doc: "print EXACTLY ONE JSON line on stdout, and ALWAYS exit 0"). Anything
 * that isn't that shape — no output, a spawn that never ran, malformed JSON
 * — is `{ok:false, reason:"..."}`, never treated as success (DX-3367 review
 * finding 3).
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
 * outcome — never throws out of this function (a spawn failure, e.g. npx
 * missing, becomes `{ok:false, reason:...}` too, per DX-3367 review finding
 * 3: "failures leave evidence" requires the caller to actually SEE the
 * outcome rather than this function swallowing it). `stdio` pipes stdout so
 * the one JSON line the subcommand promises to print can be read; stdin is
 * ignored (nothing to send) and stderr is ignored (human diagnostics only,
 * per the subcommand's own contract doc).
 */
export function reportToDashboard({ countOrClear, sessionId, env = process.env, spawnFn = spawnSync, platform, execPath, exists, timeoutMs = REPORT_SPAWN_TIMEOUT_MS }) {
  try {
    const { command, args } = reportCommand({ countOrClear, platform, execPath, exists });
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

/** Whether `sessionId` is currently plan-connected, resolving `home` the same way `plan-connect-mantra.mjs` does (env override for tests, real homedir in production). */
function sessionIsConnected(sessionId, env, isConnected) {
  return isConnected(sessionId, env?.DANXBOT_PLAN_SESSIONS_HOME || undefined);
}

/**
 * Fold one report attempt's outcome into the previous state (DX-3367 review
 * finding 3). A SUCCESSFUL report (`outcome.ok === true`) is the only thing
 * allowed to advance `count`/`reportedAt` — those two fields mean "the
 * dashboard has this count, as of this time", and a failed PUT never made
 * that true. A FAILED report still leaves evidence (`outcome` always
 * reflects the real `{ok, reason}` the subcommand returned) without lying
 * about what got stored: `count`/`reportedAt` fall back to whatever was
 * already on record (or `null` if there was never a successful report at
 * all) rather than advancing to the just-attempted, never-confirmed value.
 */
function nextReportState(previous, { count, counted, ignoredTypes, outcome, now }) {
  if (outcome.ok) {
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
  if (!sessionIsConnected(sessionId, env, isConnected)) return; // DX-3367 review finding 1 — never spawn for an unconnected session
  const backgroundTasks = input?.background_tasks;
  const count = countFromSnapshot(backgroundTasks);
  const counted = countedEntriesFromSnapshot(backgroundTasks);
  const ignoredTypes = ignoredTypesFromSnapshot(backgroundTasks);
  const outcome = reportToDashboard({ countOrClear: countArg(count), sessionId, env, spawnFn, platform, execPath, exists });
  const dir = stateDir(env);
  const { state } = sessionPaths(dir, sessionId);
  const previous = readJsonFile(state);
  const nowMs = now ? now() : Date.now();
  writeFileAtomic(state, JSON.stringify(nextReportState(previous, { count, counted, ignoredTypes, outcome, now: nowMs })));
}

/** `session-start` / `stop-failure`: no snapshot to trust — always clear, and drop the local record ONLY once the clear itself is confirmed. */
export function runClear(input, { env, spawnFn, platform, execPath, exists, isConnected = isPlanConnected } = {}) {
  const sessionId = input?.session_id;
  if (!isValidSessionId(sessionId)) return;
  if (!sessionIsConnected(sessionId, env, isConnected)) return; // DX-3367 review finding 1
  const outcome = reportToDashboard({ countOrClear: "clear", sessionId, env, spawnFn, platform, execPath, exists });
  const dir = stateDir(env);
  const { state } = sessionPaths(dir, sessionId);
  if (outcome.ok) {
    fs.rmSync(state, { force: true });
    return;
  }
  // DX-3367 review finding 3: a FAILED clear must not look identical to a
  // successful one — dropping the file here would silently claim the
  // dashboard's count was reset when it was not. Keep whatever was last
  // actually confirmed (nextReportState falls back to `previous` on
  // failure) and record the failure itself as evidence.
  const previous = readJsonFile(state);
  writeFileAtomic(state, JSON.stringify(nextReportState(previous, { count: null, outcome })));
}

/**
 * `heartbeat`: a PostToolUse(`.*`) no-op almost always. Only acts when
 * `agent_id` proves a background sub-agent is alive AND the throttle window
 * has elapsed, and only ever RE-reports a count already on record.
 *
 * DX-3367 review finding 5 (the heartbeat race): the throttle stamp is
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
  if (!sessionIsConnected(sessionId, env, isConnected)) return; // DX-3367 review finding 1

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
  if (typeof stored?.count !== "number") return; // nothing honest to refresh

  // Claim the throttle stamp BEFORE spawning — see the finding-5 doc comment above.
  writeFileAtomic(heartbeat, JSON.stringify({ lastTickAt: new Date(nowMs).toISOString() }));
  try {
    fs.utimesSync(heartbeat, new Date(nowMs), new Date(nowMs));
  } catch {
    /* removed concurrently — nothing to touch */
  }

  const outcome = reportToDashboard({ countOrClear: countArg(stored.count), sessionId, env, spawnFn, platform, execPath, exists });

  // Compare-and-set: only refresh `reportedAt` if the state file is still
  // exactly what it was before the spawn — a fresher write in the meantime
  // wins unconditionally.
  // DX-3367 comment 7171: a heartbeat re-report carries the counted list
  // (and ignoredTypes) forward UNCHANGED — it re-confirms the same snapshot
  // that produced `stored.count`, and has no new snapshot of its own to
  // derive a list from. Fabricating one here would silently disagree with
  // what was actually reported.
  compareAndSetFile(
    state,
    stateRaw,
    JSON.stringify(nextReportState(stored, { count: stored.count, counted: stored.counted, ignoredTypes: stored.ignoredTypes, outcome, now: nowMs })),
  );
}

/**
 * The routing table from a hook's `mode` argv string to the handler it
 * dispatches to — exported so mode routing itself is unit-tested without a
 * spawned process (DX-3367 review finding 8). `hooks/hooks.json` is the
 * single source of which event sends which literal mode string; a test
 * parses that file directly rather than duplicating the strings here.
 */
export function dispatchMode(mode, input, options) {
  if (mode === "stop" || mode === "subagent-stop") return runReport(input, options);
  if (mode === "session-start" || mode === "stop-failure") return runClear(input, options);
  if (mode === "heartbeat") return runHeartbeat(input, options);
  return undefined; // unknown mode — silent no-op, matches the CLI-robustness contract
}

function main() {
  const mode = process.argv[2];
  const input = readStdinJson();
  if (!input) return; // malformed/empty stdin — never block or guess
  const env = process.env;
  try {
    dispatchMode(mode, input, { env });
  } catch {
    // A hook bug must never surface as a failed/blocked tool call or turn.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
