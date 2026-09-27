#!/usr/bin/env node
/**
 * danxbot plan event bridge (DX-2784) — delivers a danxbot Plan's dashboard events
 * into the Claude Code session connected to it.
 *
 * WHY. Operators answer questions and comment on the cards of a danxbot Plan in the
 * dashboard, and the session working that plan must hear each event at once. Monitor
 * stops after 30 minutes, plugin `monitors/` are skipped without a TTY (Desktop), and
 * MCP channels need a launch flag — so a process that lives as long as the session
 * relays each event into the session's own inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`),
 * which starts a turn in an idle session.
 *
 * WHAT THIS SCRIPT OWNS, AND WHAT IT DOES NOT. It owns process lifecycle (one bridge per
 * session, start / stop / yield), the delivered-id cursor, and the inbox post. It knows
 * NOTHING about the dashboard's HTTP contract — and, since DX-2862, nothing about its
 * CREDENTIAL either: `danx-dashboard-mcp bridge` (the MCP package, pinned below) reads
 * the connection this session's own danx-dashboard MCP server recorded when it connected
 * the plan, resolves that same credential, mints the ticket, proves it can read every
 * board of the plan, streams, re-mints, and ends with one machine-readable stop record
 * naming why and how to fix it. That contract is written and tested once, in the danxbot
 * repo, beside the MCP server that already speaks it.
 *
 * WHY THE CREDENTIAL MOVED THERE. This process runs in the SESSION's environment, which
 * is not the MCP server's. Using its own ambient `DANXBOT_DISPATCH_TOKEN` meant that on a
 * machine where those two differ, the bridge signed in as somebody else: the stream was
 * admitted, nothing errored, `sessionListenerAttached` read true, and every operator
 * comment was dropped (DX-2862).
 *
 * FAIL LOUD, IN THE SESSION. A failure a session cannot otherwise see is posted into its
 * inbox as one plain message naming the reason and the fix. When the inbox itself is what
 * is missing, `start` exits 2 with the notice on stderr, which `asyncRewake` shows Claude.
 * A log line alone is not a report — nobody is reading that file.
 *
 * WHEN IT RUNS. PostToolUse on `plan_connect` and SessionStart run `start`. A session
 * that is not connected to a plan gets a bridge that exits at once: the subcommand's
 * first mint answers `not_connected`, which is terminal, and which a session start
 * passes over in silence unless this session has had events before.
 *
 * LIVENESS AUTHORITY (DX-2894). The bridge's own periodic check of its Claude process
 * (`CLAUDE_PID`) is the SOLE authority on whether the session it serves is still alive.
 * `SessionEnd` only makes shutdown faster when it fires — nothing depends on it, because
 * the official docs say it does not run on a crash or kill. `CLAUDE_PID` itself is an
 * OBSERVED, UNDOCUMENTED dependency (it does not appear on
 * https://code.claude.com/docs/en/hooks); a bridge that cannot see a valid, readable
 * `CLAUDE_PID` at startup refuses to start rather than silently running unsupervised — and
 * so does a bridge on a platform this liveness check does not support at all.
 *
 * TWO CADENCES. A cheap `isAlive(pid)` runs every PARENT_CHECK_MS (5s) — no subprocess,
 * nothing to time out — and ends the bridge with a normal (non-fatal) stop the instant the
 * pid itself is gone. Pid-REUSE detection is a heavier, async, timeout-bounded OS query
 * (Windows CIM / darwin `ps`), so it runs on the much slower START_KEY_CHECK_MS (60s)
 * instead: it records the parent's start time at startup and treats a DIFFERENT process now
 * answering for the same pid as reuse (also a normal stop). A single unreadable start-key
 * read is explicitly NOT treated as "gone" — it is logged and tolerated up to
 * START_KEY_UNREADABLE_LIMIT CONSECUTIVE attempts (a successful read resets the count); only
 * exhausting that limit is a FATAL stop, worded as "liveness could not be verified", never
 * "gone". The start-key cadence runs on a self-rescheduling `setTimeout`, never a plain
 * `setInterval` — the next check is armed only once the current one (and any `tellSession`
 * await on a fatal verdict) has fully settled, so two checks can never be in flight at once,
 * and the reschedule chain is `.catch`-guarded so a bug in the tick itself cannot vanish as
 * an unhandled rejection. The darwin start key is pinned to UTC/`C` the same way the win32
 * one is. Every fatal liveness notice — startup AND periodic — names the last underlying
 * read error, not just that the limit was hit.
 *
 * MODES
 *   start    — the hooks (SessionStart, `plan_connect`, and the DX-2953 watchdog when it
 *              decides to restart). Under an exclusive-create lock: a live holder with a
 *              fresh heartbeat → no-op; otherwise spawn `run` and record its pid.
 *   run      — the bridge itself: supervises the subcommand, relays its events, and is
 *              itself supervised by the CLAUDE_PID liveness check above.
 *   stop     — SessionEnd. Signals a live holder, whose SIGTERM handler ends its child.
 *   watchdog — DX-2953: PostToolUse (all tools) and Stop. Throttled file stats that
 *              restart a stale bridge for a session known to be connected, through the
 *              SAME `start` path above — see `watchdogTick` and `shouldWatchdogRestart`.
 *
 * STATE lives under `${CLAUDE_PLUGIN_DATA}/plan-event-bridge/`, one set per session:
 * `<session>.pid.json` (`{pid, sessionId, heartbeatAt}`), `<session>.lock` (held only
 * during `start`), `<session>.cursor.json` (`{deliveredIds}`, kept across SessionEnd so
 * a resumed session continues), `<session>.log` (no secrets), `<session>.stopped.json`
 * (the most recent stop record — DX-3028), and the DX-2953 watchdog trio:
 * `<session>.started.json` (written only by `start()`, under its lock — `lastStartedInstance`,
 * `startInputs`, `restartGeneration`, `consumedStopInstance`, `startedAt`),
 * `<session>.connected.json` (written only by the run process — `connected`, `instanceId`,
 * `at`) and `<session>.watchdog.json` (the watchdog's own once-per-WATCHDOG_THROTTLE_MS
 * throttle stamp). Two markers, not one, because `start()` releases `.lock` before
 * awaiting the bridge's own verdict — see `sessionPaths` and `buildStartedRecord` for why
 * a single shared marker would lose an update under that race. Every write is
 * write-then-rename. Files untouched for STALE_STATE_MS are pruned — the dashboard
 * keeps only a week of events, so an older cursor cannot resume anything; the watchdog's
 * own tick `utimesSync`-es `.started.json`/`.connected.json` so a live session's markers
 * are never pruned out from under it (see `watchdogTick`).
 */

import { spawn, spawnSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ONE place the MCP package version this plugin runs is named. DX-2784: it must be
 * the version published with the `bridge` subcommand; move it to the version that
 * release actually publishes.
 */
export const DASHBOARD_MCP_PACKAGE = "@thehammer/danx-dashboard-mcp@0.1.95";
export const BRIDGE_SUBCOMMAND = "bridge";

export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT_STALE_MS = 90_000;
/** The cheap per-tick liveness check (DX-2894): `isAlive(pid)` only — no subprocess, nothing to time out. */
const PARENT_CHECK_MS = 5_000;
/**
 * The SLOWER cadence for start-key (pid-reuse) verification (DX-2894). A synchronous
 * subprocess call here would block the bridge's whole event loop (heartbeat, relay, signal
 * handlers) once per tick for the life of the session, so this stays async and runs far less
 * often than the cheap `isAlive` check: the cheap check runs every PARENT_CHECK_MS, the
 * heavier, timeout-bounded start-key read runs only this often.
 */
export const START_KEY_CHECK_MS = 60_000;
/** Hard cap on a single start-key read (CIM query / `ps`), so a hung OS call cannot hang the bridge. */
export const START_KEY_READ_TIMEOUT_MS = 5_000;
/**
 * Consecutive unreadable start-key attempts (pid still alive) tolerated before liveness is
 * treated as unverifiable and the bridge shuts down fatally (DX-2894) — a single failed read
 * is deliberately NOT treated as "the process is gone", since a transient PowerShell/CIM
 * hiccup must never stop a perfectly healthy session's bridge. A successful read at any point
 * resets the counter to zero.
 */
export const START_KEY_UNREADABLE_LIMIT = 3;
/** A start that crashed mid-claim leaves its lock; one older than this is taken over. */
export const LOCK_STALE_MS = 30_000;
export const SOCKET_POST_ATTEMPTS = 3;
const REDELIVERY_INITIAL_BACKOFF_MS = 1_000;
const REDELIVERY_MAX_BACKOFF_MS = 60_000;
/** A subcommand that ran this long before dying without a stop record is restarted; a quicker death is terminal. */
export const HEALTHY_RUN_MS = 60_000;
/**
 * DX-2953 — the watchdog's own tick cadence: how often a PostToolUse/Stop
 * hook invocation actually DOES anything, throttled by a timestamp file
 * (`sessionPaths(...).watchdog`). Every tick in between is a no-op file stat.
 */
export const WATCHDOG_THROTTLE_MS = 60_000;
const RESTART_DELAY_MS = 1_000;
const DRAIN_ON_EXIT_MS = 10_000;
const LOG_MAX_BYTES = 1_000_000;
export const STDERR_TAIL_CHARS = 2_000;
export const CURSOR_ID_MEMORY = 100;
export const STALE_STATE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * createRelayQueue's in-memory bound (DX-2784). Matches CURSOR_ID_MEMORY deliberately: the
 * cursor already treats "100 events" as this bridge's unit of memory, and a backlog this
 * large means the inbox has been failing long enough that it is not a transient blip — it's
 * time to stop holding events in an unbounded array (an OOM risk) and let a restart resume
 * the stream from the dashboard instead.
 */
export const RELAY_QUEUE_CAP = CURSOR_ID_MEMORY;

/**
 * The one short tag every machine-posted bridge message starts with, so the session knows
 * what kind of message it is. Everything about HOW to handle these messages lives in
 * danxbot:plan-workflow's "Live events" section, never repeated per message (operator,
 * 2026-09-27: a bridge message can arrive dozens of times a session). The inbox delivers
 * it as a user turn and no hook-input field identifies a message's source, so content is
 * the only marker available. No other plugin reads this literal since DX-3235.
 */
export const RELAY_MARKER = "[danxbot plan event]";

/** Prefix of every relayed dashboard event: the tag alone. */
export const RELAY_PREFIX = RELAY_MARKER;

/** Prefix of every bridge failure notice. */
export const FAILURE_PREFIX = `${RELAY_MARKER} bridge down:`;

/**
 * DX-2862 — the ONE wording for a failure a session could not otherwise see.
 * Every path that ends a bridge without events flowing goes through this, so a
 * session is never left to infer silence from the absence of messages.
 */
export function failureNotice(reason, fix) {
  const trim = (text) => String(text ?? "").trim().replace(/\.+$/, "");
  return (
    `${FAILURE_PREFIX} events are NOT reaching this session: ${trim(reason)}. ` +
    `Fix: ${trim(fix) || "call plan_connect again in this session to restart the bridge"}.`
  );
}

/**
 * What the process needs before a bridge can do anything useful.
 *
 * DX-2862 — the dashboard URL and credential are NOT here any more. The bridge
 * subcommand takes them from the connection record this session's own
 * danx-dashboard MCP server wrote, so that the stream is minted with the SAME
 * credential the session's tools use. Reading them from this process's ambient
 * environment is what silently signed a bridge in as somebody else.
 */
export const REQUIRED_ENV = ["CLAUDE_PLUGIN_DATA", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"];

/** How long `start` waits for the bridge's own verdict before letting the hook finish. */
export const STARTUP_VERDICT_MS = 45_000;

/** The hook that ran `start`, and so whether this session is KNOWN to want plan events. */
export const CONNECT_INTENT = "connect";
export const RESUME_INTENT = "resume";

// DX-3028 (AC3) — `.stopped.json` added alongside the existing suffixes so
// `pruneStale` reaches it too (see `sessionPaths`'s `stopped` path below).
// DX-2953 (AC3/AC4) — `.started.json` / `.connected.json` (the two marker
// files) and `.watchdog.json` (the throttle stamp) are added the same way,
// for the same reason: pruneStale must reach every state file, and the
// watchdog's own 60s tick is what keeps a LIVE session's markers from aging
// past STALE_STATE_MS (see the watchdog tick below).
const STATE_SUFFIXES = [".pid.json", ".lock", ".cursor.json", ".log", ".stopped.json", ".started.json", ".connected.json", ".watchdog.json", ".tmp"];

// ------------------------------------------------------------------ state files

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
    // DX-3028 (AC3) — the MCP child's `stopped` record (reason, detail, fix,
    // paths, instanceId, degraded), persisted here by `run()` the moment the
    // child reports one, whether or not it then stays alive in degraded
    // mode. DX-2953's watchdog reads this file, its `reasons` and its
    // `instanceId` — it did not exist before this card.
    stopped: `${base}.stopped.json`,
    // DX-2953 — the two-marker-file split (see the module docblock addendum
    // above `start()`). `started`: written ONLY by `start()`, under
    // `paths.lock`, at the mint site — `lastStartedInstance`, `startInputs`,
    // `restartGeneration`, `consumedStopInstance`, `startedAt`. `connected`:
    // written ONLY by the run process — `connected`, `instanceId`, `at`.
    // Splitting them (instead of one shared marker) removes the lost-update
    // race a single file would have: `start()` releases `.lock` in its
    // `finally` BEFORE awaiting the bridge's own verdict, so a `plan_connect`
    // start can race the previous child's ready write; two files with one
    // writer each can never lose either field to that race.
    started: `${base}.started.json`,
    connected: `${base}.connected.json`,
    // DX-2953 — the watchdog's own once-per-WATCHDOG_THROTTLE_MS throttle
    // stamp. Its own mtime IS its content (no fields read besides existence),
    // and it doubles as the reference tick that also refreshes the two
    // marker files' mtimes so `pruneStale` never reclaims a live session's
    // markers (see the watchdog tick below).
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

/**
 * DX-3028 (AC3) — the ONE writer of `paths.stopped`. Fires for every stop
 * record the MCP child emits, degraded or not (`runChildOnce`'s `onStopped`,
 * threaded through `superviseBridge`) — a plain overwrite, since only the
 * MOST RECENT record matters to a reader (DX-2953's watchdog compares its
 * `instanceId` against the marker's `lastStartedInstance` itself; this
 * function does no such filtering — it just persists what it was handed).
 * `writingInstanceId` is THIS run process's own identity (`run()`'s
 * `instanceId`, from `DANX_BRIDGE_INSTANCE_ID`) — kept distinct from
 * `record.instanceId` (the MCP CHILD's own, which `bridge.ts` already
 * stamped) as a second field, in case the two ever need to be told apart;
 * today they are always the same value, since the run process passes its
 * own instance id to its child via the SAME env var (`childEnv`).
 */
export function persistStopRecord(file, record, writingInstanceId, now = Date.now()) {
  writeFileAtomic(
    file,
    JSON.stringify({
      schemaVersion: 1,
      reason: record.reason,
      detail: record.detail,
      fix: record.fix,
      paths: record.paths ?? [],
      instanceId: record.instanceId || writingInstanceId,
      writingInstanceId,
      degraded: record.degraded === true,
      recordedAt: new Date(now).toISOString(),
    }),
  );
}

/**
 * DX-3028 (AC2/AC3) — `instanceId` and `startedAt` are the two fields this
 * card adds. `instanceId` is minted once by `start()` (see there) and
 * carried into every heartbeat/stop record the run process and its MCP
 * child produce for this spawn — DX-2953's watchdog compares a stop
 * record's `instanceId` against `lastStartedInstance` to tell a still-
 * current record from one an earlier, since-superseded instance left
 * behind. `startedAt` lets a reused pid (an unrelated process later
 * landing on the same pid number) never be mistaken for the same
 * instance merely because the pid number matches.
 */
export function pidRecord(pid, sessionId, now = Date.now(), instanceId = null) {
  const iso = new Date(now).toISOString();
  return { pid, sessionId, heartbeatAt: iso, instanceId, startedAt: iso };
}

/** A pid file whose process is alive AND has heartbeated recently. */
export function isFreshHolder(record, { isAlive: alive = isAlive, now = Date.now() } = {}) {
  return Boolean(record) && alive(record.pid) && now - Date.parse(record.heartbeatAt ?? "") < HEARTBEAT_STALE_MS;
}

// ------------------------------------------------------------- DX-2953: watchdog

/**
 * DX-2953 — write the `.connected.json` marker. The run process is the ONLY
 * writer (see `sessionPaths`'s `connected` field doc); every call site in
 * `run()` fences this on `.pid.json`'s `instanceId` still equalling its own
 * first, so a superseded run process can never clobber a fresher one's
 * marker (see `run()`'s `writeConnected` closure).
 */
export function writeConnectedMarker(file, { connected, instanceId, now = Date.now() }) {
  writeFileAtomic(file, JSON.stringify({ connected: connected === true, instanceId, at: new Date(now).toISOString() }));
}

/**
 * DX-2953 — the fenced write `run()` actually calls: writes `.connected.json`
 * ONLY while `.pid.json`'s `instanceId` still equals this call's own —
 * reusing the exact yield rule `heartbeatTick` already applies (`.pid.json`'s
 * `instanceId` is set only by `start()` under the lock and merely preserved
 * by the heartbeat, so this is free of ABA). Exported and independently
 * testable so the "a superseded run process's write is refused" concurrency
 * case (`plan_connect` `start()` racing the previous child's ready write)
 * needs no spawned process, no lock, and no clock — just two calls in a
 * controlled order against the same `paths.pid`.
 */
export function writeConnectedIfCurrent(paths, { connected, instanceId, now = Date.now() }) {
  const held = readJsonFile(paths.pid);
  if (!held || held.instanceId !== instanceId) return { written: false };
  writeConnectedMarker(paths.connected, { connected, instanceId, now });
  return { written: true };
}

/**
 * DX-2953 — reasons that must NEVER cause a `.connected.json` write. Per the
 * card: `no_connection_record` and `session_is_worker` never prove the
 * session is bound to a plan, and every `bridge_failed` record this plugin
 * ever persists (see `start()`'s `spawnRun` catch and `run()`'s own
 * liveness-check fatal paths) is, by construction, a failure that happened
 * BEFORE any mint was attempted — none of these three prove the session is
 * bound. Every other reason (including `not_connected`, which instead
 * writes `connected:false`) reaches a mint or a stream, so it DOES prove
 * binding.
 */
export const CONNECTED_WRITE_SKIP_REASONS = new Set(["no_connection_record", "session_is_worker", "bridge_failed"]);

/**
 * DX-2953 — stop reasons that ALWAYS forbid a watchdog restart, regardless
 * of `restartGeneration` or `consumedStopInstance`: the session is either
 * definitively not connected, or another listener already has (or will)
 * cover it. `bridge_failed` is handled separately (see
 * `shouldWatchdogRestart`) — it forbids a restart only once already
 * consumed, or while `restartGeneration` has not reset.
 */
export const FORBID_RESTART_ALWAYS = new Set(["no_connection_record", "not_connected", "superseded", "replaced", "session_is_worker"]);

/**
 * DX-2953 — write the `.started.json` marker's full record. `start()` is the
 * ONLY caller (always under `paths.lock`, at the mint site). Pure so the
 * generation/consumed-instance arithmetic is unit-tested without a lock, a
 * clock, or a spawned process.
 *
 * A NON-watchdog start (SessionStart / `plan_connect`) is a deliberate,
 * operator/system-driven fresh start unrelated to any crash-loop history, so
 * it resets `restartGeneration` to 0 and `consumedStopInstance` to null
 * outright. A watchdog-triggered start bumps `effectiveRestartGeneration`
 * (see below) by one, and records `consumeStopInstance` (the bridge_failed
 * record's `writingInstanceId`, when that is what triggered the restart) as
 * `consumedStopInstance` — never `null`-ing out a value the caller did not
 * pass, but never carrying one forward from an unrelated prior instance
 * either, since `lastStartedInstance` is about to change either way.
 */
export function buildStartedRecord({ instanceId, sessionId, intent, transcriptPath = null, prevStarted = null, stoppedRecord = null, restartTrigger, consumeStopInstance = null, now }) {
  const isWatchdog = restartTrigger === "watchdog";
  const restartGeneration = isWatchdog ? effectiveRestartGeneration({ startedRecord: prevStarted, stoppedRecord, now }) + 1 : 0;
  return {
    lastStartedInstance: instanceId,
    startInputs: { sessionId, intent, transcriptPath },
    restartGeneration,
    consumedStopInstance: isWatchdog ? (consumeStopInstance ?? null) : null,
    startedAt: new Date(now).toISOString(),
  };
}

/**
 * DX-2953 — the crash-loop guard: how many watchdog-triggered restarts this
 * "unhealthy streak" has already spent. `.started.json`'s `restartGeneration`
 * is a literal, start()-written integer (single-writer, per the card), but
 * ITS RESET is computed lazily here rather than written by a third party
 * (which the two-marker design forbids): once the CURRENT `lastStartedInstance`
 * has been alive at least HEALTHY_RUN_MS — measured from `startedAt` to
 * either its OWN applicable stop record's `recordedAt` (it died, but lived
 * long enough first) or `now` (it might still be alive/healthy right now) —
 * the streak is over and the effective generation reads as 0, even though
 * the stored value stays whatever it was until the NEXT `start()` call
 * persists the collapsed value (the sole writer catching up on its own next
 * write). Mirrors `classifyChildExit`'s existing `ranMs >= HEALTHY_RUN_MS`
 * pattern for the analogous subcommand-restart decision.
 */
export function effectiveRestartGeneration({ startedRecord, stoppedRecord = null, now, healthyRunMs = HEALTHY_RUN_MS }) {
  const stored = startedRecord?.restartGeneration ?? 0;
  if (stored <= 0) return 0;
  const startedAt = Date.parse(startedRecord?.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return stored;
  const appliesToCurrent = stoppedRecord && stoppedRecord.writingInstanceId === startedRecord.lastStartedInstance;
  const recordedAt = appliesToCurrent ? Date.parse(stoppedRecord.recordedAt ?? "") : NaN;
  const ranUntil = Number.isFinite(recordedAt) ? recordedAt : now;
  return ranUntil - startedAt >= healthyRunMs ? 0 : stored;
}

/** A `.pid.json` record the watchdog considers stale: missing, or heartbeatAt older than heartbeatStaleMs. */
export function isMarkerStale({ pidRecord, now, heartbeatStaleMs = HEARTBEAT_STALE_MS }) {
  if (!pidRecord) return true;
  const heartbeatAt = Date.parse(pidRecord.heartbeatAt ?? "");
  if (!Number.isFinite(heartbeatAt)) return true;
  return now - heartbeatAt > heartbeatStaleMs;
}

/**
 * DX-2953 — the watchdog's whole restart decision, pure (no fs, no clock
 * besides the injected `now`) so every branch in the card's checklist is
 * unit-tested without a spawned process. Reads exactly the four inputs the
 * card names: `.pid.json` (staleness), `.started.json` (`lastStartedInstance`
 * / `restartGeneration` / `consumedStopInstance`), `.connected.json`
 * (whether this session is known to want a bridge at all), and
 * `.stopped.json` (why the last one ended) — NEVER the stopped record's
 * `paths` field, which is the live child's own watched-path retry input,
 * not the watchdog's concern.
 *
 * Matches a stop record to the CURRENT instance on `writingInstanceId` ONLY
 * — never `instanceId`, which `bridge.ts` stamps independently and which
 * silently drifts to a fresh `randomUUID()` there on its own (see
 * `resolveInstanceId` in `bridge.ts`, and the module docblock's drift
 * section). A record from any other (superseded) instance is not
 * "applicable" and never forbids or gates anything.
 */
export function shouldWatchdogRestart({ pidRecord, startedRecord, connectedRecord, stoppedRecord, now, heartbeatStaleMs = HEARTBEAT_STALE_MS }) {
  if (!connectedRecord || connectedRecord.connected !== true) {
    return { restart: false, reason: "this session is not known to be connected to a plan" };
  }
  if (!isMarkerStale({ pidRecord, now, heartbeatStaleMs })) {
    return { restart: false, reason: "the bridge is not stale" };
  }
  const lastStartedInstance = startedRecord?.lastStartedInstance ?? null;
  const applicable = stoppedRecord && lastStartedInstance && stoppedRecord.writingInstanceId === lastStartedInstance ? stoppedRecord : null;
  if (applicable) {
    if (FORBID_RESTART_ALWAYS.has(applicable.reason)) {
      return { restart: false, reason: `an applicable stop record forbids a restart: ${applicable.reason}` };
    }
    if (applicable.reason === "bridge_failed") {
      const consumedInstance = applicable.writingInstanceId;
      if (startedRecord?.consumedStopInstance === consumedInstance) {
        return { restart: false, reason: "this bridge_failed record was already consumed by an earlier watchdog restart" };
      }
      if (effectiveRestartGeneration({ startedRecord, stoppedRecord, now }) > 0) {
        return { restart: false, reason: "restartGeneration has not reset since the last watchdog restart" };
      }
      return { restart: true, reason: `restarting after bridge_failed: ${applicable.detail}`, consumeStopInstance: consumedInstance };
    }
    // Every other applicable reason (a degraded reason left by a bridge
    // killed while degraded, revoked, refused, scope_narrowed, ...) does not
    // forbid a restart on its own — see the module docblock's "restart
    // decision reads the stop record" section.
  }
  if (effectiveRestartGeneration({ startedRecord, stoppedRecord, now }) > 0) {
    return { restart: false, reason: "restartGeneration has not reset since the last watchdog restart" };
  }
  return {
    restart: true,
    reason: applicable ? `restarting: an applicable stop record (${applicable.reason}) does not forbid it` : "the bridge is stale with no applicable stop record",
  };
}

/** Exclusive-create lock. `false` means another start holds it (and it is not stale). */
export function acquireLock(lockFile, now = Date.now()) {
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx"));
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let ageMs;
      try {
        ageMs = now - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // released between the create and the stat
      }
      if (ageMs <= LOCK_STALE_MS) return false;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return false;
}

/** Remove every session state file nothing has touched for STALE_STATE_MS. */
export function pruneStale(dir, now = Date.now()) {
  for (const name of fs.readdirSync(dir)) {
    if (!STATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_STATE_MS) fs.rmSync(file, { force: true });
    } catch {
      /* removed by another start */
    }
  }
}

// ------------------------------------------------------------------- processes

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Platforms this bridge knows how to read a process start time on (DX-2894). */
export const SUPPORTED_START_KEY_PLATFORMS = ["win32", "linux", "darwin"];

/**
 * The fatal-refusal wording for a platform with no supported way to verify liveness — names
 * the platform explicitly (never a generic "unreadable" message, which would wrongly suggest
 * a transient failure that a retry could fix) so a session on an unsupported platform gets an
 * actionable "not supported" notice, never a "restart" hint that could never help.
 */
export function unsupportedPlatformNotice(platform) {
  return {
    reason: `this platform (${platform}) is not supported by the plan event bridge's liveness check`,
    fix: `plan event bridge liveness verification only runs on ${SUPPORTED_START_KEY_PLATFORMS.join(", ")} — ${platform} needs support added before a bridge can run here`,
  };
}

/**
 * A short, appendable description of a start-key read failure (DX-2894) — `err.message`
 * alone renders an `execFile` timeout kill (win32 CIM / darwin `ps`) as an indistinguishable
 * generic wrapper string ("Command failed" or similar), with no hint it was ever bounded
 * rather than simply refused. Every caller that logs or reports a start-key `onFailure` /
 * `onUnreadableAttempt` error goes through this, so a timeout reads as a timeout wherever it
 * surfaces — the bridge log AND the fatal session notice — on both the win32 and darwin
 * `execFile` paths.
 */
export function describeProcessError(err) {
  if (err === null || err === undefined) return "unknown error";
  const parts = [err.message ?? String(err)];
  if (err.killed) parts.push("killed=true");
  if (err.signal) parts.push(`signal=${err.signal}`);
  if (err.code !== undefined && err.code !== null) parts.push(`code=${err.code}`);
  return parts.join(" ");
}

/**
 * A stable identifier for "when process `pid` started" (DX-2894) — a bare `kill(pid, 0)`
 * cannot tell a live parent apart from an unrelated process that later reused its pid, so
 * the periodic parent check needs something that changes when the pid is recycled. Resolves
 * `null` when the pid cannot be found (or its start time cannot be read) at all — "gone" and
 * "unreadable" are deliberately the same answer at THIS layer, since the caller
 * (`verifyStartKeyTick`) is the one place that decides what unreadable means (transient vs.
 * exhausted). The three platforms' keys are incomparable formats on purpose; nothing ever
 * compares a Windows key against a Linux or darwin one.
 *
 * `onFailure` (default no-op) is called with the real underlying error or reason exactly when
 * the result is null because a read genuinely failed — timeout, spawn error, non-zero exit,
 * empty output, or an invalid pid — so a caller can log WHY, not just that it did.
 *
 * win32 and darwin run their OS query through `execFile` — NEVER `execFileSync`/`spawnSync` —
 * bounded by `timeoutMs` (default START_KEY_READ_TIMEOUT_MS): a synchronous subprocess call
 * here would block the bridge's whole event loop (heartbeat, relay, signal handlers) for as
 * long as the OS call takes, once per check, for the life of the session. Linux reads `/proc`
 * directly — no subprocess, already non-blocking, no timeout needed. The Windows key is read
 * in UTC (`ToUniversalTime()`) so an operator's own timezone change can never read as pid
 * reuse. The darwin key is likewise pinned (`TZ=UTC` + `LC_ALL=C`) — `ps -o lstart=` carries
 * no offset in its output at all, so without an explicit override it would silently read the
 * host's local timezone and locale.
 */
export function readProcessStartKey(
  pid,
  {
    platform = process.platform,
    execFileFn = execFile,
    readFile = (file) => fs.promises.readFile(file, "utf8"),
    timeoutMs = START_KEY_READ_TIMEOUT_MS,
    onFailure = () => {},
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    onFailure(new Error(`invalid pid: ${pid}`));
    return Promise.resolve(null);
  }
  if (platform === "win32") {
    return new Promise((resolve) => {
      execFileFn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
        (error, stdout) => {
          if (error) {
            onFailure(error);
            resolve(null);
            return;
          }
          const stamp = (stdout ?? "").trim();
          if (stamp === "") onFailure(new Error(`no CIM CreationDate for pid ${pid}`));
          resolve(stamp === "" ? null : stamp);
        },
      );
    });
  }
  if (platform === "darwin") {
    return new Promise((resolve) => {
      execFileFn(
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        // DX-2894: `ps -o lstart=` renders in the process's LOCAL timezone/locale with no
        // offset anywhere in the output, so with no override an operator's own timezone
        // change (or a differently-configured host) would silently become part of the
        // comparison key — the same class of bug the win32 CIM read avoids by reading UTC.
        // TZ=UTC + LC_ALL=C pin both.
        { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
        (error, stdout) => {
          if (error) {
            onFailure(error);
            resolve(null);
            return;
          }
          const stamp = (stdout ?? "").trim();
          if (stamp === "") onFailure(new Error(`no ps lstart output for pid ${pid}`));
          resolve(stamp === "" ? null : `darwin:${stamp}`);
        },
      );
    });
  }
  if (platform === "linux") {
    // /proc/<pid>/stat field 22 (starttime, clock ticks since boot) is stable for the life
    // of a pid and needs no clock/timezone handling. `comm` (field 2) is parenthesized and
    // may itself contain spaces or `)`, so the split point is the LAST ')' in the line,
    // never a naive split(" ").
    return readFile(`/proc/${pid}/stat`).then(
      (stat) => {
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim();
        const starttime = afterComm.split(/\s+/)[19]; // field 22 overall; fields[0] here is field 3 (state)
        if (!/^\d+$/.test(starttime ?? "")) {
          onFailure(new Error(`could not parse starttime out of /proc/${pid}/stat`));
          return null;
        }
        return `linux:${starttime}`;
      },
      (err) => {
        onFailure(err);
        return null;
      },
    );
  }
  onFailure(new Error(`no supported way to read a process start time on platform "${platform}"`));
  return Promise.resolve(null);
}

/**
 * One periodic start-key (pid-reuse) verification (DX-2894). Runs on the SLOWER
 * START_KEY_CHECK_MS cadence, never the cheap per-tick `isAlive` check — and only does
 * anything when the pid is still alive (a dead pid is the cheap tick's job; reading a dead
 * pid's start key here would just fail and get misreported as "unverifiable" rather than the
 * correct "exited").
 *
 * A DIFFERENT start key than the one recorded at startup means the pid was reused by another
 * process — `action: "reused"`, always a normal (non-fatal) stop, exactly like a genuinely
 * exited parent.
 *
 * An UNREADABLE key is NOT treated as "gone" — a single transient read failure must never stop
 * a perfectly healthy session's bridge. Each unreadable attempt is reported through
 * `onUnreadableAttempt` and counted; a successful read at any point resets the counter to zero.
 * Only after `unreadableLimit` CONSECUTIVE unreadable attempts does this report
 * `action: "unverifiable"` — fatal, because liveness genuinely cannot be established either
 * way, which is a materially different (and differently worded) situation from "gone".
 *
 * Pure aside from the injected `isAlive` / `readProcessStartKey` calls, so the whole decision
 * table (reused / unverifiable / none, and the counter arithmetic) is unit-tested without
 * spawning a process or waiting on a real timer.
 */
export async function verifyStartKeyTick(
  pid,
  expectedKey,
  {
    isAlive: alive = isAlive,
    readProcessStartKey: readKey = readProcessStartKey,
    platform = process.platform,
    timeoutMs = START_KEY_READ_TIMEOUT_MS,
    unreadableCount = 0,
    unreadableLimit = START_KEY_UNREADABLE_LIMIT,
    onUnreadableAttempt = () => {},
  } = {},
) {
  if (!alive(pid)) return { action: "none", unreadableCount };
  const currentKey = await readKey(pid, {
    platform,
    timeoutMs,
    onFailure: (err) => onUnreadableAttempt(err, unreadableCount + 1, unreadableLimit),
  });
  if (currentKey === null) {
    const nextCount = unreadableCount + 1;
    return { action: nextCount >= unreadableLimit ? "unverifiable" : "none", unreadableCount: nextCount };
  }
  if (currentKey !== expectedKey) return { action: "reused", unreadableCount: 0 };
  return { action: "none", unreadableCount: 0 };
}

/**
 * End a process and its descendants. On Windows `taskkill /T` walks the tree. On POSIX
 * the signal goes to the process GROUP — the run process and the subcommand are each
 * spawned detached, so each leads its own group.
 */
export function killTree(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------- start / stop

/** The remedy for each thing a start can be missing. One map, one wording. */
export const MISSING_ENV_FIXES = {
  "session id": "the hook gave no session_id — run the bridge from the danxbot plugin's hooks, never by hand",
  CLAUDE_PLUGIN_DATA:
    "Claude Code sets CLAUDE_PLUGIN_DATA for a plugin's own hooks — reinstall the danxbot plugin if this session has no plugin data directory",
  CLAUDE_CODE_MESSAGING_SOCKET:
    "this Claude Code surface exposes no session inbox, so no background process can deliver anything into this session — work a plan from a surface that has one",
  CLAUDE_CODE_MESSAGING_TOKEN:
    "this Claude Code surface exposes no session inbox token, so no background process can deliver anything into this session",
};

export function fixForMissing(missing) {
  const fixes = missing.map((name) => MISSING_ENV_FIXES[name]).filter(Boolean);
  return fixes.length > 0 ? [...new Set(fixes)].join("; ") : "restart this session from the danxbot plugin's hooks";
}

/**
 * Is this session KNOWN to want plan events?
 *
 * A `plan_connect` says yes outright. A session start says nothing either way —
 * the plugin loads in every session, most of which never touch a plan — so a
 * failure there is announced only when this session has been delivered events
 * before (it has a cursor). Announcing in every session would train everyone to
 * ignore the notice, which is the same silence by another route.
 */
export function isSessionKnownToWantEvents({ intent, env, sessionId }) {
  if (intent === CONNECT_INTENT) return true;
  if (!env.CLAUDE_PLUGIN_DATA || !sessionId) return false;
  try {
    return readCursor(sessionPaths(stateDir(env), sessionId).cursor).length > 0;
  } catch {
    return false;
  }
}

/**
 * Tell the session, in the session — the whole point of DX-2862. The inbox is
 * the only channel it can read; `stderr` is the fallback for when the inbox
 * itself is what is missing, which a hook surfaces through `asyncRewake` on
 * exit code 2 (`hooks/hooks.json`). Log-only is not an option here.
 */
export async function announce({ reason, fix, env, post = postToInbox, stderr = () => {}, relevant = true }) {
  const notice = failureNotice(reason, fix);
  if (!relevant) return { announced: false, posted: false, notice, exitCode: 0 };
  if (env.CLAUDE_CODE_MESSAGING_SOCKET && env.CLAUDE_CODE_MESSAGING_TOKEN) {
    for (let attempt = 1; attempt <= SOCKET_POST_ATTEMPTS; attempt += 1) {
      try {
        await post(notice, env);
        return { announced: true, posted: true, notice, exitCode: 0 };
      } catch {
        /* try again; the stderr path below is the last resort */
      }
    }
  }
  stderr(`${notice}\n`);
  return { announced: true, posted: false, notice, exitCode: 2 };
}

/**
 * Wait for the bridge's own verdict — `ready` once it is streaming with a
 * verified credential, or `failed` with what it already told the session.
 * Resolves `null` if neither arrives in time: the bridge is still trying, and a
 * hook that waited forever would be worse than one that lets it.
 */
export function waitForVerdict(child, timeoutMs) {
  if (typeof child?.on !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("message", onMessage);
      child.removeListener?.("exit", onExit);
      try {
        child.disconnect?.();
      } catch {
        /* the channel is already gone */
      }
      child.unref?.();
      resolve(value);
    };
    const onMessage = (message) => {
      if (message && typeof message === "object" && typeof message.verdict === "string") finish(message);
    };
    const onExit = (code) => finish({ verdict: "exited", code });
    // Deliberately NOT unref'd: this timer is the only thing holding the hook
    // process open while it waits, and a hook that exited early would report
    // success over a bridge that had not started yet.
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

/**
 * Ensure one bridge for the session, and report how it went.
 * Returns `{started, reason?, pid?, exitCode}` — `exitCode` is 2 exactly when a
 * failure could NOT be put in front of the session and the hook must wake Claude
 * with it instead (`asyncRewake`).
 *
 * A holder that is alive but has not heartbeated is REPLACED, not killed: its pid may
 * already belong to an unrelated process, and killing that would be worse than any
 * duplicate. A real stale bridge yields on its next heartbeat (the pid file names
 * another pid) and ends its own child; the new bridge's mint ends its stream anyway.
 *
 * A `plan_connect` (`intent: "connect"`) REPLACES a live bridge on purpose: the
 * session may have just moved to another plan, whose boards this credential has
 * never been checked against, and that check happens at startup.
 */
export async function start({
  env = process.env,
  sessionId,
  intent = RESUME_INTENT,
  spawnRun = spawnRunProcess,
  isAlive: alive = isAlive,
  killTree: kill = killTree,
  now = Date.now,
  stderr = (message) => process.stderr.write(message),
  post = postToInbox,
  waitVerdict = waitForVerdict,
  verdictTimeoutMs = STARTUP_VERDICT_MS,
  // DX-2953 — the hook's own `transcript_path`, recorded into `.started.json`'s
  // `startInputs` so a watchdog restart starts the bridge with exactly the
  // same inputs (DX-2954 relies on this). Never CLAUDE_PID — see the card.
  transcriptPath = null,
  // DX-2953 — set by the watchdog's own call, never by SessionStart or
  // plan_connect. Selects the generation-bump / consumed-instance behavior
  // in `buildStartedRecord` — see its doc comment.
  restartTrigger,
  consumeStopInstance = null,
} = {}) {
  const missing = [["session id", sessionId], ...REQUIRED_ENV.map((name) => [name, env[name]])]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    const announced = await announce({
      reason: `the bridge could not start (missing ${missing.join(", ")})`,
      fix: fixForMissing(missing),
      env,
      post,
      stderr,
      relevant: isSessionKnownToWantEvents({ intent, env, sessionId }),
    });
    return { started: false, reason: `missing ${missing.join(", ")}`, exitCode: announced.exitCode };
  }
  const dir = stateDir(env);
  const paths = sessionPaths(dir, sessionId);
  pruneStale(dir, now());
  if (!acquireLock(paths.lock, now())) return { started: false, reason: "another start holds the lock", exitCode: 0 };
  let child;
  try {
    const held = readJsonFile(paths.pid);
    if (isFreshHolder(held, { isAlive: alive, now: now() })) {
      if (intent !== CONNECT_INTENT) return { started: false, reason: "already bridged", exitCode: 0 };
      kill(held.pid);
      fs.rmSync(paths.pid, { force: true });
    }
    // DX-3028 (AC2/AC3) — this instance's own identity, minted here (under
    // the lock, AFTER the fresh-holder check, IMMEDIATELY before spawning —
    // a `start` that returns above without reaching this line never mints
    // one), carried into the run process's env so it reaches every
    // heartbeat/stop record it and its MCP child produce for this spawn.
    const instanceId = randomUUID();
    const nowMs = now();
    // DX-2953 (AC3) — a `spawnRun` throw is caught HERE, inside the lock,
    // rather than left to propagate: this instance was still minted and
    // "started" for bookkeeping purposes (`.started.json` gets it either
    // way), and the failure must be visible to the watchdog as a
    // `bridge_failed` record — nothing else will ever report it, since no
    // run() process came into being to report anything itself.
    try {
      child = spawnRun(sessionId, { ...env, DANX_BRIDGE_INSTANCE_ID: instanceId }, intent);
    } catch (err) {
      writeFileAtomic(
        paths.started,
        JSON.stringify(
          buildStartedRecord({
            instanceId,
            sessionId,
            intent,
            transcriptPath,
            prevStarted: readJsonFile(paths.started),
            stoppedRecord: readJsonFile(paths.stopped),
            restartTrigger,
            consumeStopInstance,
            now: nowMs,
          }),
        ),
      );
      try {
        persistStopRecord(paths.stopped, { reason: "bridge_failed", detail: `spawnRun threw: ${err.message}`, fix: "", paths: [], instanceId: "" }, instanceId, nowMs);
      } catch {
        /* best-effort — the watchdog falls back to "stale, no applicable record" either way */
      }
      return { started: false, reason: `spawnRun failed: ${err.message}`, exitCode: 2 };
    }
    writeFileAtomic(paths.pid, JSON.stringify(pidRecord(child.pid, sessionId, nowMs, instanceId)));
    // DX-2953 (AC3) — written under the SAME lock, right after the pid
    // record, on the successful path too: `.started.json` is start()'s own
    // marker regardless of whether the resulting bridge ever reaches ready.
    writeFileAtomic(
      paths.started,
      JSON.stringify(
        buildStartedRecord({
          instanceId,
          sessionId,
          intent,
          transcriptPath,
          prevStarted: readJsonFile(paths.started),
          stoppedRecord: readJsonFile(paths.stopped),
          restartTrigger,
          consumeStopInstance,
          now: nowMs,
        }),
      ),
    );
  } finally {
    fs.rmSync(paths.lock, { force: true });
  }
  const verdict = await waitVerdict(child, verdictTimeoutMs);
  return { started: true, pid: child.pid, ...startExit(verdict, stderr) };
}

/**
 * What the hook does with the bridge's verdict. Separated so the mapping is
 * exercised without spawning anything: a failure the bridge already put in the
 * session's inbox needs nothing further, one it could not needs the hook's own
 * exit code 2, and no verdict at all means it is still working.
 */
export function startExit(verdict, stderr = () => {}) {
  if (verdict === null || verdict === undefined) return { verdict: "pending", exitCode: 0 };
  if (verdict.verdict === "ready") return { verdict: "ready", exitCode: 0 };
  if (verdict.verdict === "exited") {
    const notice = failureNotice(
      `the bridge process exited (code ${verdict.code}) before it could start streaming`,
      "check the bridge log under the danxbot plugin's data directory, then call plan_connect again",
    );
    stderr(`${notice}\n`);
    return { verdict: "exited", exitCode: 2 };
  }
  if (verdict.announced && !verdict.posted) {
    stderr(`${verdict.notice}\n`);
    return { verdict: "failed", exitCode: 2 };
  }
  return { verdict: "failed", exitCode: 0 };
}

function spawnRunProcess(sessionId, env, intent) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", sessionId, intent], {
    detached: true,
    // The IPC channel carries ONE verdict back to the hook (see `start`); the
    // bridge's own output is its log, never a stream the hook holds open.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
    env,
  });
  child.unref();
  return child;
}

/** SessionEnd: end a live, heartbeating holder (never a stale pid that may be reused) and drop its pid file. */
export function stop({ env = process.env, sessionId, isAlive: alive = isAlive, killTree: kill = killTree, now = Date.now } = {}) {
  if (!env.CLAUDE_PLUGIN_DATA || typeof sessionId !== "string" || sessionId === "") return { stopped: false };
  const paths = sessionPaths(stateDir(env), sessionId);
  const held = readJsonFile(paths.pid);
  const live = isFreshHolder(held, { isAlive: alive, now: now() });
  if (live) kill(held.pid);
  fs.rmSync(paths.pid, { force: true });
  return { stopped: live };
}

// ------------------------------------------------------------------------- run

/**
 * One heartbeat. Yields (calls `shutdown`) when the pid file names another
 * bridge. DX-3028 — `instanceId`/`startedAt` are preserved from whatever
 * record is already on file (written by `start()` at spawn time), never
 * regenerated here: a heartbeat only refreshes `heartbeatAt`, so a stop
 * record written later can still be compared against the SAME identity the
 * process was spawned with. The one exception is the very first beat of a
 * process nothing has written a record for yet (`held` is absent or carries
 * no `instanceId`) — falls back to `instanceId` from this closure's own
 * caller (`run()`'s own `DANX_BRIDGE_INSTANCE_ID`) so the record is never
 * silently missing it.
 */
export function heartbeatTick({ paths, selfPid, sessionId, now = Date.now(), shutdown, instanceId = null }) {
  const held = readJsonFile(paths.pid);
  if (held && held.pid !== selfPid) {
    shutdown("another bridge owns this session");
    return false;
  }
  const record = pidRecord(selfPid, sessionId, now, held?.instanceId ?? instanceId);
  if (held?.startedAt) record.startedAt = held.startedAt;
  writeFileAtomic(paths.pid, JSON.stringify(record));
  return true;
}

/** Post one user message into this session's inbox. The server replies with nothing. */
export function postToInbox(content, env = process.env) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(env.CLAUDE_CODE_MESSAGING_SOCKET);
    sock.setTimeout(10_000);
    sock.on("timeout", () => sock.destroy(new Error("inbox socket timeout")));
    sock.on("error", reject);
    sock.on("close", (hadError) => {
      if (!hadError) resolve();
    });
    sock.on("connect", () => {
      const frames =
        JSON.stringify({ type: "auth", token: env.CLAUDE_CODE_MESSAGING_TOKEN }) +
        "\n" +
        JSON.stringify({ type: "user", message: { role: "user", content } }) +
        "\n";
      sock.end(frames);
    });
  });
}

export function relayContent(text) {
  return `${RELAY_PREFIX} ${text}`;
}

/** The ids already delivered for the session, oldest first: positive integers only, newest CURSOR_ID_MEMORY. */
export function readCursor(file) {
  const ids = readJsonFile(file)?.deliveredIds;
  return Array.isArray(ids) ? ids.filter((id) => Number.isSafeInteger(id) && id > 0).slice(-CURSOR_ID_MEMORY) : [];
}

/** Record one delivered id — deduped, capped, atomic. */
export function recordDelivered(file, id) {
  const ids = readCursor(file).filter((known) => known !== id);
  ids.push(id);
  writeFileAtomic(file, JSON.stringify({ deliveredIds: ids.slice(-CURSOR_ID_MEMORY) }));
}

export function resumeArgs(resumeIds) {
  return resumeIds.length > 0 ? ["--resume-ids", resumeIds.join(",")] : [];
}

/**
 * The subcommand's environment: the dashboard credential and session id it needs to
 * mint, and NOT the inbox token or socket, which only this process uses.
 */
export function childEnv(env, sessionId) {
  const out = { ...env, CLAUDE_CODE_SESSION_ID: sessionId };
  delete out.CLAUDE_CODE_MESSAGING_TOKEN;
  delete out.CLAUDE_CODE_MESSAGING_SOCKET;
  return out;
}

/**
 * The command that runs the subcommand — never through a shell. On Windows `npx` is a
 * `.cmd` shim Node can only start via `cmd.exe`, so run npm's own JS entry with this
 * node instead; elsewhere `npx` is an executable and is spawned directly.
 */
export function bridgeCommand({ resumeIds, platform = process.platform, execPath = process.execPath, exists = fs.existsSync }) {
  const args = ["-y", DASHBOARD_MCP_PACKAGE, BRIDGE_SUBCOMMAND, ...resumeArgs(resumeIds)];
  if (platform !== "win32") return { command: "npx", args };
  const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (!exists(npxCli)) throw new Error(`npx not found: expected ${npxCli} next to ${execPath}`);
  return { command: execPath, args: [npxCli, ...args] };
}

/** One stdout line of the subcommand, classified. */
export function parseRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: "junk" };
  }
  if (record?.type === "event" && typeof record.text === "string") {
    return { kind: "event", id: Number.isSafeInteger(record.id) && record.id > 0 ? record.id : null, text: record.text };
  }
  if (record?.type === "stopped" && typeof record.reason === "string") {
    // DX-3028 (AC3) — `paths` and `instanceId` are new on the child's own
    // stop record; `degraded` decides whether THIS parseRecord's caller
    // should treat the record as the child having exited (see `runChildOnce`
    // below) — a record missing it (an older, pre-DX-3028 subcommand)
    // defaults to `false` (exit), matching the ONLY behavior that existed
    // before this card.
    return {
      kind: "stopped",
      reason: record.reason,
      detail: String(record.detail ?? ""),
      fix: typeof record.fix === "string" ? record.fix : "",
      paths: Array.isArray(record.paths) ? record.paths.map(String) : [],
      instanceId: typeof record.instanceId === "string" ? record.instanceId : "",
      degraded: record.degraded === true,
    };
  }
  // DX-2862 — the subcommand says once, before any event, that it minted a
  // ticket AND proved its credential can read every board of the connected
  // plan. That is what `start` waits for, so a hook can report a failed start
  // rather than exiting 0 over a bridge that never worked.
  // DX-3059 — `cardCount`/`degraded` ride alongside `boards` now (DX-2970's
  // `fetchPlanInventory`, published `@thehammer/danx-dashboard-mcp@0.1.94`).
  // `boards === null` is kept distinct from `boards: []` — the published
  // shape (`BridgeReady`, bridge.ts) sends `null` ONLY when the inventory
  // read itself failed, and `[]` when the read succeeded but found no
  // boards; `onReady` below needs to tell those apart to name the right
  // problem. A pre-DX-2970 subcommand never sends `boards` at all
  // (`undefined`), which — like every other unrecognized shape here —
  // degrades to the same "[]" this parser already produced before this
  // card, not a new failure mode.
  if (record?.type === "ready") {
    return {
      kind: "ready",
      boards: record.boards === null ? null : Array.isArray(record.boards) ? record.boards.map(String) : [],
      cardCount: Number.isSafeInteger(record.cardCount) && record.cardCount >= 0 ? record.cardCount : null,
      degraded: record.degraded === true,
    };
  }
  return { kind: "junk" };
}

/**
 * DX-3059 — the "ready" log line, split into the three outcomes DX-2970's
 * `boards`/`cardCount`/`degraded` were added to distinguish. The server's own
 * `degraded` flag is deliberately NOT used as-is here: `bridge.ts` sets it
 * true both when the credential can't see any board (a real problem) AND
 * when the boards are known and reachable but the plan simply has zero cards
 * yet (not a problem at all) — see `BridgeReady` in `bridge.ts`. Telling
 * those apart needs `boards` itself, not just the flag:
 *
 *   - `boards === null` — the one best-effort inventory read failed
 *     (network/timeout/non-2xx/malformed body). Nothing is known.
 *   - `boards.length === 0` (array, but empty) — the read succeeded and
 *     this session's credential can see NO board of the connected plan.
 *   - `boards.length > 0` — real, reachable boards are known. If
 *     `cardCount === 0` too, that is a genuinely empty plan: benign, and
 *     the ONLY case allowed to print the pre-DX-2970 "no cards" text.
 *
 * A pre-DX-2970 subcommand (or the DX-2920 gap this card's parent exists to
 * close) sends none of these fields — `boards` parses to `[]`, `cardCount`
 * to `null`, `degraded` to `false` — which falls into the same "no boards
 * known, not flagged degraded" shape as a real empty-boards problem. That is
 * intentional: an old subcommand's silence about its own boards is exactly
 * the failure DX-2970 exists to stop being silent about, so it is treated as
 * the same problem here rather than defaulting to benign.
 */
export function describeReadyRecord(record) {
  const boards = record.boards;
  const cardCount = record.cardCount;
  if (!Array.isArray(boards) || boards.length === 0) {
    const why =
      boards === null
        ? "the plan inventory read failed (network/timeout/bad response), so nothing is known"
        : "this session's credential cannot see any board of the connected plan";
    return (
      `DEGRADED — ${why}. The bridge is streaming, but it may be relaying nothing. ` +
      `Check the dashboard credential's board scope and the dashboard's reachability, ` +
      `then run plan_connect again in this session once fixed.`
    );
  }
  const boardList = boards.join(", ");
  if (cardCount === 0) {
    return `streaming; this session's own credential verified against board(s) ${boardList} (no cards yet)`;
  }
  return `streaming; this session's own credential verified against board(s) ${boardList}`;
}

/** Feeds complete lines to `onLine`, however the stream happens to split its chunks. */
export function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line !== "") onLine(line);
      nl = buffer.indexOf("\n");
    }
  };
}

/**
 * Ordered delivery into the inbox. An event is recorded in the cursor only AFTER its
 * post succeeds. A post that fails every attempt is logged loudly and stays at the head
 * of the queue — later events wait behind it, so the cursor never runs ahead of a lost
 * event — and is retried with backoff. If the bridge exits first, the event was never
 * recorded, so the next bridge's resume replays it.
 *
 * The queue is bounded at `cap` (default RELAY_QUEUE_CAP): while the head keeps failing,
 * every event behind it piles up in memory with nothing draining it, so an unbounded array
 * here is a real OOM risk on a long enough outage. Overflow is NOT a silent drop — dropping
 * the oldest or newest queued event would lose it for good, with no record anywhere that it
 * ever existed. Instead `onOverflow(reason)` fires once (never enqueuing the event that
 * would have exceeded the cap) so the caller can end the process on a clearly logged reason.
 * Because none of the queued events — including the one that triggered the overflow — were
 * ever `record`ed, the cursor never advanced past them, so the next bridge run's resume
 * naturally re-streams them from the dashboard: deferred to the next process lifetime, never
 * lost.
 */
export function createRelayQueue({ post, record, log, sleep, isStopped = () => false, cap = RELAY_QUEUE_CAP, onOverflow = () => {} }) {
  const queue = [];
  let running = null;
  let overflowed = false;

  const drain = async () => {
    let backoff = REDELIVERY_INITIAL_BACKOFF_MS;
    while (queue.length > 0 && !isStopped()) {
      const event = queue[0];
      let lastError = null;
      let posted = false;
      for (let attempt = 1; attempt <= SOCKET_POST_ATTEMPTS && !posted; attempt += 1) {
        try {
          await post(relayContent(event.text));
          posted = true;
        } catch (err) {
          lastError = err;
          if (attempt < SOCKET_POST_ATTEMPTS) await sleep(1_000 * attempt);
        }
      }
      if (posted) {
        queue.shift();
        if (event.id !== null) record(event.id);
        log(`relayed event ${event.id ?? "(no id)"} (${event.text.length} chars)`);
        backoff = REDELIVERY_INITIAL_BACKOFF_MS;
        continue;
      }
      log(
        `INBOX POST FAILED for event ${event.id ?? "(no id)"} after ${SOCKET_POST_ATTEMPTS} attempts ` +
          `(${lastError?.code ?? lastError?.message}); NOT recorded — holding it and ${queue.length - 1} later ` +
          `event(s) for redelivery in ${backoff} ms`,
      );
      await sleep(backoff);
      backoff = Math.min(REDELIVERY_MAX_BACKOFF_MS, backoff * 2);
    }
  };

  const kick = () => {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      if (queue.length > 0 && !isStopped()) kick();
    });
  };

  return {
    push(event) {
      if (overflowed) return;
      if (queue.length >= cap) {
        overflowed = true;
        const reason =
          `relay queue overflow: ${cap} events are undelivered and the inbox has been failing since event ` +
          `${queue[0]?.id ?? "(no id)"}; exiting without recording any of them so the next bridge run's resume ` +
          "replays them from the dashboard";
        log(`FATAL: ${reason}`);
        onOverflow(reason);
        return;
      }
      queue.push(event);
      kick();
    },
    /** Resolves when the queue is empty (or delivery stopped). */
    async idle() {
      while (running) await running;
    },
    pending: () => queue.length,
  };
}

/**
 * What to do when the subcommand exits: `exit` the bridge with a reason, or `restart` it.
 * An exit carries `fatal`: true for a `bridge_failed` stop (the subcommand's own spawn/mint
 * failure) or a death too quick to have produced any stop record at all; false for every
 * clean stop record the subcommand reports on purpose (`not_connected`, `superseded`,
 * `revoked`, ...). `run()` threads this straight through to `shutdown()`'s own exit code —
 * see `exitCodeForShutdown` — so nothing here duplicates that decision.
 */
export function classifyChildExit({ stopped, code, ranMs }) {
  if (stopped) {
    return {
      action: "exit",
      reason: `${stopped.reason}: ${stopped.detail}`,
      fatal: stopped.reason === "bridge_failed",
      stopReason: stopped.reason,
      fix: stopped.fix ?? "",
    };
  }
  if (ranMs >= HEALTHY_RUN_MS) {
    return {
      action: "restart",
      reason: `the bridge subcommand exited (code ${code}) without a stop record after running ${Math.round(ranMs / 1000)} s`,
    };
  }
  return {
    action: "exit",
    reason: `bridge_failed: the bridge subcommand exited (code ${code}) without a stop record`,
    fatal: true,
    stopReason: "bridge_failed",
    fix: "check the bridge log in this directory for the subcommand's own stderr, then call plan_connect again",
  };
}

/**
 * Stops the session does NOT need to hear about: another listener took this
 * session's stream, which is what a restart or a reconnect looks like from
 * here, and is never a loss of events.
 */
export const SILENT_STOP_REASONS = new Set(["superseded", "replaced"]);

export function shouldAnnounceStop(stopReason, { relevant }) {
  return relevant && !SILENT_STOP_REASONS.has(stopReason);
}

/**
 * Runs the subcommand once. Resolves with its stop record (or null) and exit
 * code. DX-3028 (AC3) — `onStopped` fires for EVERY stop record the child
 * emits, degraded or not, the MOMENT it arrives (never waiting on the child
 * to actually exit) — the persistence to `paths.stopped` this drives must
 * see a degraded record too, since the child stays alive after writing one.
 * Only a NON-degraded record is kept as this call's own `stopped` result —
 * degraded records never end supervision here (the child hasn't exited, and
 * `superviseBridge`'s loop only reacts to `child.on("close")`, which a live
 * degraded child never fires).
 */
function runChildOnce({ spawnChild, relay, log, onReady, onStopped = () => {}, onEvent = () => {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnChild();
    } catch (err) {
      const record = { reason: "bridge_failed", detail: err.message, fix: "", paths: [], instanceId: "", degraded: false };
      onStopped(record);
      resolve({ stopped: record, code: null });
      return;
    }
    let stopped = null;
    let stderrTail = "";
    let settled = false;
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      if (stderrTail.trim() !== "") log(`bridge subcommand stderr (tail): ${stderrTail.trim()}`);
      const fallback = spawnError ? { reason: "bridge_failed", detail: spawnError, fix: "", paths: [], instanceId: "", degraded: false } : null;
      resolve({ stopped: stopped ?? fallback, code });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on(
      "data",
      createLineSplitter((line) => {
        const record = parseRecord(line);
        if (record.kind === "event") {
          relay.push({ id: record.id, text: record.text });
          // DX-2953 — a real relayed event is the only proof available that a
          // previously-degraded child has recovered to streaming (bridge.ts
          // never emits a second "ready" on recovery — see the module
          // docblock's marker-liveness section). Clearing here is what makes
          // "a bridge that degraded, recovered, then was hard-killed IS
          // restarted" work: its own stale degraded record is gone by then.
          onEvent();
        } else if (record.kind === "stopped") {
          const full = { reason: record.reason, detail: record.detail, fix: record.fix, paths: record.paths, instanceId: record.instanceId, degraded: record.degraded };
          onStopped(full);
          // DX-3028 (AC2) — a DEGRADED record does NOT end this promise: the
          // child stays alive (heartbeating, retrying per its own policy),
          // so `stopped` is deliberately left `null` and this call keeps
          // waiting on the real `child.on("close")` below — which a live
          // degraded child never fires until it is actually killed or later
          // reaches a genuinely terminal reason.
          if (!record.degraded) stopped = full;
        } else if (record.kind === "ready") onReady(record);
        else log(`ignored non-record output from the bridge subcommand (${line.length} chars)`);
      }),
    );
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code, null));
  });
}

/**
 * Run the subcommand until it reports a terminal outcome or dies too early to restart.
 * Returns `{ reason, fatal }` — see `classifyChildExit` for what makes an exit fatal.
 */
export async function superviseBridge({ spawnChild, relay, log, now = Date.now, sleep, onReady = () => {}, onStopped = () => {}, onEvent = () => {} }) {
  for (;;) {
    const startedAt = now();
    const outcome = await runChildOnce({ spawnChild, relay, log, onReady, onStopped, onEvent });
    const decision = classifyChildExit({ ...outcome, ranMs: now() - startedAt });
    if (decision.action === "exit") {
      return { reason: decision.reason, fatal: decision.fatal, stopReason: decision.stopReason, fix: decision.fix };
    }
    log(`restarting the bridge subcommand: ${decision.reason}`);
    await sleep(RESTART_DELAY_MS);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The process exit code for a shutdown, so a FATAL condition (a relay-queue overflow, a
 * subcommand that never produced a stop record) is distinguishable from a normal stop
 * (SessionEnd, yielding to a fresher bridge, the parent process ending, a clean stop record
 * like `not_connected`) by anything watching this process's exit code alone. The ONE call
 * site (`shutdown`, in `run()`) decides `fatal` from where it was called, never duplicating
 * this mapping.
 */
export function exitCodeForShutdown(fatal) {
  return fatal ? 1 : 0;
}

/**
 * `run()`'s two terminal events, mapped to the `{why, fatal}` it hands `shutdown()`. There are
 * exactly two: the relay queue's overflow (`createRelayQueue` only ever calls `onOverflow` on
 * cap breach, and that is always fatal — the events behind it are undelivered, not lost, only
 * because the process is about to die and let the next run's resume replay them) and
 * `superviseBridge`'s own resolution (fatal exactly when `classifyChildExit` decided so).
 * `run()`'s two `shutdown(...)` call sites are built from this one function instead of each
 * inlining the fatal decision, so the wiring is exercised by a test with nothing to spawn.
 */
export function terminalShutdown(event) {
  if ("overflow" in event) return { why: event.overflow, fatal: true };
  return { why: event.supervised.reason, fatal: event.supervised.fatal };
}

/**
 * The real bridge subcommand child, built from `bridgeCommand()` — the only piece of
 * `run()` that actually spawns the dashboard-talking process. Injectable (`run()`'s
 * `spawnSubcommand`) so tests can replace it with a stand-in that never touches the
 * network; see `danxbot/tests/fixtures/run-bridge.mjs`.
 */
function defaultSpawnSubcommand({ resumeIds, env }) {
  const { command, args } = bridgeCommand({ resumeIds });
  return spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

export async function run(
  sessionId,
  intent = RESUME_INTENT,
  env = process.env,
  {
    spawnSubcommand = defaultSpawnSubcommand,
    post: postFn = postToInbox,
    readProcessStartKey: readStartKey = readProcessStartKey,
    isAlive: alive = isAlive,
    platform = process.platform,
    parentCheckMs = PARENT_CHECK_MS,
    startKeyCheckMs = START_KEY_CHECK_MS,
    startKeyTimeoutMs = START_KEY_READ_TIMEOUT_MS,
    unreadableLimit = START_KEY_UNREADABLE_LIMIT,
  } = {},
) {
  const paths = sessionPaths(stateDir(env), sessionId);
  try {
    if (fs.statSync(paths.log).size > LOG_MAX_BYTES) fs.truncateSync(paths.log, 0);
  } catch {
    /* no log yet */
  }
  const log = (message) => fs.appendFileSync(paths.log, `${new Date().toISOString()} ${message}\n`);
  // DX-2862 — whether this session is KNOWN to want plan events decides whether a
  // failure is put in front of it or only logged. A `plan_connect` says yes
  // outright; a session start says yes only if this session has been delivered
  // events before.
  const relevant = intent === CONNECT_INTENT || readCursor(paths.cursor).length > 0;
  const parentPid = Number(env.CLAUDE_PID);
  let child = null;
  let stopping = false;
  let verdictSent = false;
  let startKeyTimer = null;

  /** The hook that started this bridge waits for exactly one of these. */
  const sendVerdict = (verdict) => {
    if (verdictSent) return;
    verdictSent = true;
    try {
      process.send?.(verdict);
    } catch {
      /* the hook has already finished — its own timeout covered this */
    }
  };

  /** Put a failure in front of the session, and tell the hook whether that worked. */
  const tellSession = async (reason, fix) => {
    const result = await announce({
      reason,
      fix,
      env,
      post: (content) => postFn(content, env),
      stderr: (message) => log(`could NOT reach this session's inbox: ${message.trim()}`),
      relevant,
    });
    log(result.posted ? `told the session: ${reason}` : `NOT told the session (relevant=${relevant}): ${reason}`);
    sendVerdict({ verdict: "failed", announced: result.announced, posted: result.posted, notice: result.notice });
  };

  const shutdown = (why, { fatal = false } = {}) => {
    if (stopping) return;
    stopping = true;
    log(`exiting: ${why}`);
    // DX-2894: clear the self-rescheduling start-key timer explicitly — process.exit() below
    // ends the process either way, but this keeps "shutdown stops every timer" true as an
    // invariant of the function itself, not an accident of how Node tears down on exit.
    if (startKeyTimer) clearTimeout(startKeyTimer);
    if (child) killTree(child.pid);
    if (readJsonFile(paths.pid)?.pid === process.pid) fs.rmSync(paths.pid, { force: true });
    process.exit(exitCodeForShutdown(fatal));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(`received ${signal}`));

  // DX-2953 — this run process's own identity. `start()` is the ONLY sanctioned
  // spawner (:741-ish, "carries a minted instanceId into the run process's own
  // env as DANX_BRIDGE_INSTANCE_ID") and always sets this var, so a missing one
  // means a real bug in THIS plugin, not a session condition — refuse loudly
  // rather than silently minting a fresh randomUUID() here. A phantom identity
  // would poison `writingInstanceId`, which the watchdog's whole restart-match
  // design depends on being genuine (a stop record it can never match against
  // `.started.json`'s `lastStartedInstance` would restart a `not_connected`
  // session every 60s forever — see the module docblock's drift section).
  const declaredInstanceId = typeof env.DANX_BRIDGE_INSTANCE_ID === "string" ? env.DANX_BRIDGE_INSTANCE_ID.trim() : "";
  if (declaredInstanceId === "") {
    await tellSession(
      "this run process has no DANX_BRIDGE_INSTANCE_ID (a plugin bug, not a session problem)",
      "restart the session so start() can mint a fresh instance id for a new bridge",
    );
    shutdown("DANX_BRIDGE_INSTANCE_ID is missing from this run process's environment", { fatal: true });
    return;
  }
  const instanceId = declaredInstanceId;

  /** DX-2953 — every "run fails a startup check before it is ready" fatal path
   * (CLAUDE_PID missing, unsupported platform, unreadable start key) writes a
   * bridge_failed record naming its instance BEFORE it exits — the ONLY way
   * the watchdog can ever learn this instance never got anywhere, and so
   * apply its one-restart-then-stop crash-loop guard instead of restarting
   * every 60s forever. Deliberately NOT persisted via the onStopped path
   * below (that is for records the MCP CHILD reports; these are the RUN
   * process's own pre-mint refusals) and deliberately never touches
   * `.connected.json` (see CONNECTED_WRITE_SKIP_REASONS — a pre-mint
   * bridge_failed never proves the session is bound to a plan). */
  const persistBridgeFailed = (detail, fix) => {
    try {
      persistStopRecord(paths.stopped, { reason: "bridge_failed", detail, fix: fix ?? "", paths: [], instanceId: "", degraded: false }, instanceId, Date.now());
    } catch (err) {
      log(`could not persist the bridge_failed stop record: ${err.message}`);
    }
  };

  // DX-2894 — the bridge's own check of its Claude process is the SOLE liveness
  // authority (SessionEnd only makes shutdown faster; nothing depends on it firing,
  // and it does not run on a crash or kill). CLAUDE_PID is an observed, undocumented
  // dependency (not on https://code.claude.com/docs/en/hooks) — a missing or invalid
  // value is a loud refusal to start, never a silent "rely on SessionEnd" fallback.
  //
  // Every check below runs BEFORE the first heartbeat write (`beat()`) or any other state
  // that claims this bridge for the session — a doomed bridge that is about to refuse and
  // exit must never touch `paths.pid` first.
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    persistBridgeFailed("CLAUDE_PID is missing or not a valid process id");
    await tellSession(
      "CLAUDE_PID is missing or not a valid process id",
      "CLAUDE_PID is an observed, undocumented Claude Code dependency (not in the public hooks docs) — restart the session so the plugin can observe it again",
    );
    shutdown("CLAUDE_PID is missing or not a valid process id", { fatal: true });
    return;
  }
  if (!SUPPORTED_START_KEY_PLATFORMS.includes(platform)) {
    const { reason, fix } = unsupportedPlatformNotice(platform);
    persistBridgeFailed(reason, fix);
    await tellSession(reason, fix);
    shutdown(reason, { fatal: true });
    return;
  }
  // DX-2894: a parent already dead at startup takes the same normal "exited" stop the
  // periodic isAlive check takes below — never the "could not read start time" fatal
  // refusal, which is reserved for a LIVE pid whose start time genuinely could not be read.
  if (!alive(parentPid)) {
    shutdown(`Claude Code process ${parentPid} exited`);
    return;
  }
  // Record the parent's start time now, so a LATER pid reuse (an unrelated process
  // that lands on this same pid after the real Claude process exits) is detectable —
  // a bare `kill(pid, 0)` cannot tell the two apart. Unreadable at startup is refused
  // loudly, never a silent skip of the guard. Async + timeout-bounded like every other
  // start-key read (see `readProcessStartKey`).
  //
  // DX-2894: track the real underlying error so the fatal session notice below can name it
  // — the session sees only this notice, never the log file.
  let lastStartKeyError = null;
  const parentStartKey = await readStartKey(parentPid, {
    platform,
    timeoutMs: startKeyTimeoutMs,
    onFailure: (err) => {
      lastStartKeyError = err;
      log(`could not read the start time of Claude Code process ${parentPid} at startup: ${describeProcessError(err)}`);
    },
  });
  if (parentStartKey === null) {
    // DX-2894: the parent can die in the window between the `alive(parentPid)` check above and
    // this read returning — a dead parent makes every OS start-time query fail the same way an
    // unreadable-but-live one does, so an unqualified null here would misreport an ordinary
    // "the session ended while we were starting up" as the fatal "could not verify" refusal.
    // Re-check liveness before deciding which of the two this is.
    if (!alive(parentPid)) {
      shutdown(`Claude Code process ${parentPid} exited`);
      return;
    }
    persistBridgeFailed(
      `could not read the start time of Claude Code process ${parentPid} at startup: ${describeProcessError(lastStartKeyError)}`,
      "restart the session so the plugin can observe CLAUDE_PID again",
    );
    await tellSession(
      `could not read the start time of Claude Code process ${parentPid} (CLAUDE_PID): ${describeProcessError(lastStartKeyError)}`,
      "restart the session so the plugin can observe CLAUDE_PID again",
    );
    shutdown(`could not read the start time of Claude Code process ${parentPid}`, { fatal: true });
    return;
  }

  // DX-2953 — `instanceId` is resolved once, loudly, near the top of this
  // function now (see the DANX_BRIDGE_INSTANCE_ID refusal above) — no second
  // resolution here.
  const beat = () => {
    try {
      heartbeatTick({ paths, selfPid: process.pid, sessionId, shutdown, instanceId });
    } catch (err) {
      log(`heartbeat write failed: ${err.message}`);
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_MS);

  // The cheap per-tick check (every parentCheckMs, default 5s): no subprocess, nothing to
  // time out. A dead pid is a normal (non-fatal) stop.
  setInterval(() => {
    if (!alive(parentPid)) shutdown(`Claude Code process ${parentPid} exited`);
  }, parentCheckMs);

  // The heavier pid-reuse verification (every startKeyCheckMs, default 60s) — see
  // `verifyStartKeyTick` for the full decision table. `unreadableCount` is this closure's
  // own running tally across ticks; a successful read resets it to zero.
  //
  // DX-2894: a self-rescheduling `setTimeout`, never a plain `setInterval`, keeps checks
  // strictly non-overlapping — the NEXT check is armed only once the current one (and any
  // `await tellSession` on a fatal verdict) has fully settled (`finally`, so a
  // thrown/rejected tick still reschedules rather than silently going quiet). A plain
  // `setInterval` would re-fire regardless of whether the previous tick's async OS read had
  // settled, letting two reads overlap and mutate the same `unreadableCount` closure
  // variable concurrently.
  let unreadableCount = 0;
  const runStartKeyCheck = async () => {
    const { action, unreadableCount: nextCount } = await verifyStartKeyTick(parentPid, parentStartKey, {
      isAlive: alive,
      readProcessStartKey: readStartKey,
      platform,
      timeoutMs: startKeyTimeoutMs,
      unreadableCount,
      unreadableLimit,
      onUnreadableAttempt: (err, attempt, limit) => {
        lastStartKeyError = err;
        log(`could not verify Claude Code process ${parentPid}'s start time (attempt ${attempt}/${limit}): ${describeProcessError(err)}`);
      },
    });
    unreadableCount = nextCount;
    if (action === "reused") {
      shutdown(`pid ${parentPid} was reused by another process`);
    } else if (action === "unverifiable") {
      // DX-2894: name the last real error, not just that the limit was hit — the session
      // sees only this notice.
      const reason =
        `Claude Code process ${parentPid}'s liveness could not be verified after ${unreadableLimit} consecutive ` +
        `attempts: ${describeProcessError(lastStartKeyError)}`;
      await tellSession(reason, "restart the session so the plugin can observe CLAUDE_PID again");
      shutdown(reason, { fatal: true });
    }
  };
  const scheduleStartKeyCheck = () => {
    if (stopping) return;
    startKeyTimer = setTimeout(() => {
      runStartKeyCheck()
        .catch(async (err) => {
          // DX-2894: a bug in the tick itself (never a start-key READ failure, which
          // `verifyStartKeyTick` already turns into "unverifiable" rather than throwing) must
          // end the bridge the same way every other fatal liveness path does — reported to
          // the session, not just logged. The shutdown must still happen even if telling the
          // session itself fails, so that failure is swallowed here rather than left to skip
          // the shutdown below.
          const reason = `start-key verification failed unexpectedly: ${describeProcessError(err)}`;
          await tellSession(reason, "restart the session so the plugin can observe CLAUDE_PID again").catch((tellErr) => {
            // DX-2894: this failure must never be silent — the session was never told, and the
            // log is the only remaining record. Guard the logging itself: it is best-effort
            // here, and must not stop the fatal shutdown below from running.
            try {
              log(`could NOT tell the session about the start-key verification failure: ${tellErr?.message ?? tellErr}`);
            } catch {
              /* logging itself failed — fall through to shutdown regardless */
            }
          });
          shutdown(reason, { fatal: true });
        })
        .finally(() => scheduleStartKeyCheck());
    }, startKeyCheckMs);
  };
  scheduleStartKeyCheck();

  const relay = createRelayQueue({
    post: (content) => postFn(content, env),
    record: (id) => recordDelivered(paths.cursor, id),
    log,
    sleep,
    isStopped: () => stopping,
    onOverflow: (reason) => {
      const { why, fatal } = terminalShutdown({ overflow: reason });
      void tellSession(why, "call plan_connect again in this session once its inbox is accepting messages").then(() =>
        shutdown(why, { fatal }),
      );
    },
  });

  // DX-2953 — `.connected.json` is this run process's OWN marker (see
  // `sessionPaths`). Fenced on `.pid.json`'s `instanceId` still equalling
  // this process's own, reusing the same yield rule `heartbeatTick` already
  // applies: `.pid.json`'s `instanceId` is set only by `start()` under the
  // lock and merely preserved by the heartbeat, so a superseded run process
  // (one `start()` has already replaced) can never clobber a fresher one's
  // marker with this check in place — free of ABA for the same reason.
  const writeConnected = (connected) => {
    try {
      const result = writeConnectedIfCurrent(paths, { connected, instanceId, now: Date.now() });
      if (!result.written) log(`skipped writing the connected marker (connected=${connected}): another instance now owns .pid.json`);
    } catch (err) {
      log(`could not write the connected marker: ${err.message}`);
    }
  };
  /** DX-2953 — a bridge reaching ready, or returning to streaming from degraded
   * mode (see the `onEvent` wiring below), deletes every stop record for its
   * session, its own included — otherwise its own now-resolved degraded
   * record would linger as "applicable" for a later, unrelated hard kill. */
  const clearStopRecord = () => {
    try {
      fs.rmSync(paths.stopped, { force: true });
    } catch {
      /* nothing to clear */
    }
  };

  log(`bridge started for session ${sessionId} (pid ${process.pid}, ${intent})`);
  const supervised = await superviseBridge({
    spawnChild: () => {
      const resumeIds = readCursor(paths.cursor);
      child = spawnSubcommand({ resumeIds, env: childEnv(env, sessionId) });
      log(`bridge subcommand started${resumeIds.length > 0 ? `, resuming after event ${Math.max(...resumeIds)}` : ""}`);
      return child;
    },
    relay,
    log,
    sleep,
    onReady: (record) => {
      // DX-3059 — `describeReadyRecord` tells a degraded ready record (the
      // bridge cannot see what it should) apart from a genuinely empty plan
      // (benign) and a populated one; see its own doc comment for why the
      // server's coarse `degraded` flag alone can't make that call.
      log(describeReadyRecord(record));
      // DX-2953 — reaching ready proves this session is bound to a plan
      // (connected:true) and retires whatever stop record was sitting here.
      clearStopRecord();
      writeConnected(true);
      sendVerdict({ verdict: "ready" });
    },
    // DX-3028 (AC3) — persisted the MOMENT the child reports it, before this
    // process knows whether the child will stay alive (degraded) or exit —
    // DX-2953's watchdog reads this file, its `reasons` and its
    // `instanceId`, so it must exist as soon as the child says so, not only
    // once this run process itself terminates.
    onStopped: (record) => {
      log(`bridge subcommand reported ${record.reason}${record.degraded ? " (degraded — staying alive)" : ""}: ${record.detail}`);
      try {
        persistStopRecord(paths.stopped, record, instanceId);
      } catch (err) {
        log(`could not persist the stop record: ${err.message}`);
      }
      // DX-2953 — cross-repo instance-id drift detection: `record.instanceId`
      // is the MCP CHILD's own (bridge.ts's `resolveInstanceId`), which
      // silently mints a fresh randomUUID() on its own when its env var has
      // drifted — see the module docblock's drift section. The watchdog
      // never trusts this field (it matches on `writingInstanceId` alone);
      // this just makes a real drift visible instead of silently harmless.
      if (record.instanceId && record.instanceId !== instanceId) {
        log(`instance id drift: the stop record's own instanceId (${record.instanceId}) differs from this run process's writingInstanceId (${instanceId})`);
      }
      // DX-2953 — the connected marker: see CONNECTED_WRITE_SKIP_REASONS for
      // which reasons never touch it. `not_connected` writes connected:false;
      // every other non-skipped reason proves the session IS bound, so it
      // writes connected:true (this includes a degraded reason like
      // board_unreadable — see the module docblock's "what connected means").
      if (!CONNECTED_WRITE_SKIP_REASONS.has(record.reason)) {
        writeConnected(record.reason !== "not_connected");
      }
    },
    onEvent: () => {
      clearStopRecord();
    },
  });
  child = null;
  await Promise.race([relay.idle(), sleep(DRAIN_ON_EXIT_MS)]);
  const terminal = terminalShutdown({ supervised });
  if (shouldAnnounceStop(supervised.stopReason, { relevant })) await tellSession(terminal.why, supervised.fix);
  // A stop nobody needed to hear about still ends the hook's wait, so it exits
  // on the bridge's own timing rather than on its timeout.
  sendVerdict({ verdict: "failed", announced: false, posted: false, notice: "" });
  shutdown(terminal.why, { fatal: terminal.fatal });
}

// ------------------------------------------------------------------------ main

/**
 * Which hook ran this. `hooks.json` fires PostToolUse only on `plan_connect`, so
 * that event IS "this session just connected a plan": the one moment the bridge
 * must be (re)started and every failure told to the session, whatever state the
 * session was in before.
 */
export function intentFromHookEvent(hookEventName) {
  return hookEventName === "PostToolUse" ? CONNECT_INTENT : RESUME_INTENT;
}

/** The hook's stdin JSON carries `session_id`, `hook_event_name` and `transcript_path`; a hand run has none. */
async function readHookInput() {
  const fallback = { sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, intent: RESUME_INTENT, transcriptPath: null };
  if (process.stdin.isTTY) return fallback;
  const chunks = [];
  await new Promise((resolve) => {
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    setTimeout(resolve, 500);
  });
  process.stdin.pause();
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = typeof parsed.session_id === "string" && parsed.session_id !== "" ? parsed.session_id : fallback.sessionId;
    // DX-2953 — `transcript_path` rides the same stdin JSON every hook event
    // already carries (confirmed against the documented UserPromptSubmit
    // input shape — see the module docblock's RELAY_MARKER comment); recorded
    // into `.started.json`'s `startInputs` so a watchdog restart starts the
    // bridge with exactly the same inputs the triggering hook received.
    const transcriptPath = typeof parsed.transcript_path === "string" && parsed.transcript_path !== "" ? parsed.transcript_path : null;
    return { sessionId: id, intent: intentFromHookEvent(parsed.hook_event_name), transcriptPath };
  } catch {
    return fallback;
  }
}

/**
 * DX-2953 — the watchdog tick: what `PostToolUse` (all tools) and `Stop` run.
 * Throttled to once per `throttleMs` via `paths.watchdog`'s own mtime — every
 * tick in between does exactly one `fs.statSync` and returns. On an actual
 * tick: refresh the throttle stamp, `utimesSync` both marker files (the named
 * toucher that keeps `pruneStale` from reclaiming a live session's markers —
 * see the module docblock), read the four state files, and hand them to the
 * pure `shouldWatchdogRestart`. Only when it says to restart does this call
 * `startFn` (the injected `start`) — the healthy path never spawns anything.
 */
export async function watchdogTick({
  env = process.env,
  sessionId,
  transcriptPath = null,
  now = Date.now,
  isAlive: alive = isAlive,
  killTree: kill = killTree,
  stderr = (message) => process.stderr.write(message),
  post = postToInbox,
  waitVerdict = waitForVerdict,
  verdictTimeoutMs = STARTUP_VERDICT_MS,
  spawnRun = spawnRunProcess,
  startFn = start,
  throttleMs = WATCHDOG_THROTTLE_MS,
  heartbeatStaleMs = HEARTBEAT_STALE_MS,
} = {}) {
  if (!env.CLAUDE_PLUGIN_DATA || typeof sessionId !== "string" || sessionId === "") {
    return { ticked: false, restarted: false, exitCode: 0 };
  }
  const dir = stateDir(env);
  const paths = sessionPaths(dir, sessionId);
  const nowMs = now();
  let throttleAge = Infinity;
  try {
    throttleAge = nowMs - fs.statSync(paths.watchdog).mtimeMs;
  } catch {
    /* never ticked before — a fresh tick is due */
  }
  if (throttleAge < throttleMs) {
    return { ticked: false, restarted: false, exitCode: 0 };
  }
  writeFileAtomic(paths.watchdog, JSON.stringify({ lastTickAt: new Date(nowMs).toISOString() }));
  // DX-2953: stamp the throttle file's own mtime to the INJECTED now, not
  // whatever the real OS clock was at write time — the throttle compare
  // below is against this same injected `now()`, and every other timing
  // decision in this module (heartbeat staleness, restartGeneration) is
  // fully deterministic under an injected clock; the throttle must be too.
  const touch = (file) => {
    try {
      fs.utimesSync(file, new Date(nowMs), new Date(nowMs));
    } catch {
      /* does not exist yet, or was removed concurrently — nothing to touch */
    }
  };
  touch(paths.watchdog);
  touch(paths.started);
  touch(paths.connected);

  const decision = shouldWatchdogRestart({
    pidRecord: readJsonFile(paths.pid),
    startedRecord: readJsonFile(paths.started),
    connectedRecord: readJsonFile(paths.connected),
    stoppedRecord: readJsonFile(paths.stopped),
    now: nowMs,
    heartbeatStaleMs,
  });
  if (!decision.restart) {
    return { ticked: true, restarted: false, reason: decision.reason, exitCode: 0 };
  }
  const result = await startFn({
    env,
    sessionId,
    intent: RESUME_INTENT,
    transcriptPath,
    restartTrigger: "watchdog",
    consumeStopInstance: decision.consumeStopInstance,
    spawnRun,
    isAlive: alive,
    killTree: kill,
    now,
    stderr,
    post,
    waitVerdict,
    verdictTimeoutMs,
  });
  return { ticked: true, restarted: result.started === true, reason: decision.reason, startResult: result, exitCode: result.exitCode ?? 0 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [mode, arg, intentArg] = process.argv.slice(2);
  const modes = {
    start: async () => {
      const hook = await readHookInput();
      const result = await start({ sessionId: hook.sessionId, intent: hook.intent, transcriptPath: hook.transcriptPath });
      process.exit(result.exitCode ?? 0);
    },
    stop: async () => {
      const hook = await readHookInput();
      stop({ sessionId: hook.sessionId });
      process.exit(0);
    },
    // DX-2953 — the watchdog: PostToolUse (all tools) and Stop both run this.
    watchdog: async () => {
      const hook = await readHookInput();
      const result = await watchdogTick({ sessionId: hook.sessionId, transcriptPath: hook.transcriptPath });
      process.exit(result.exitCode ?? 0);
    },
    run: () => run(arg, intentArg),
  };
  const main = modes[mode];
  if (!main) {
    process.stderr.write("usage: plan-event-bridge.mjs start|stop|watchdog|run <session-id>\n");
    process.exit(2);
  }
  Promise.resolve()
    .then(main)
    .catch((err) => {
      process.stderr.write(`danxbot plan event bridge ${mode} failed: ${err.message}\n`);
      process.exit(1);
    });
}
