#!/usr/bin/env node
/**
 * danxbot plan event bridge — relays a danxbot plan's dashboard events into the Claude
 * Code session connected to it, through the session's own inbox socket
 * (`CLAUDE_CODE_MESSAGING_SOCKET`), which starts a turn in an idle session. A long-lived
 * process is the delivery path because Monitor stops after 30 minutes, plugin `monitors/`
 * are skipped without a TTY, and MCP channels need a launch flag.
 *
 * SPLIT OF RESPONSIBILITY. This script owns process lifecycle (one bridge per session),
 * the delivered-id cursor and the inbox post. The recorded-version `danx-dashboard-mcp bridge`
 * subcommand owns everything about the dashboard: it resolves the credential this
 * session's own MCP server recorded at connect (never this process's ambient env, which
 * can belong to a different dashboard), mints the ticket, checks every board of the plan,
 * streams, re-mints, and ends with one stop record naming why and how to fix it.
 *
 * FAIL LOUD, IN THE SESSION. A failure the session cannot otherwise see is posted into
 * its inbox as one plain message with the reason and the fix. When the inbox itself is
 * missing, `start` exits 2 with the notice on stderr, which `asyncRewake` shows Claude.
 *
 * WHEN IT RUNS. `plan_connect` (PostToolUse) always runs `start`. SessionStart runs it
 * only for a plan-connected session (`lib/plan-connection.mjs`, see `hookMayStart`).
 *
 * LIVENESS. The bridge's own check of its Claude process (`CLAUDE_PID`, observed but
 * undocumented) is the sole authority on whether the session is alive; SessionEnd only
 * speeds shutdown. A cheap `isAlive(pid)` runs every PARENT_CHECK_MS; pid-reuse detection
 * (an async, timeout-bounded OS query) runs every START_KEY_CHECK_MS, tolerating up to
 * START_KEY_UNREADABLE_LIMIT consecutive unreadable reads before a fatal stop.
 *
 * MODES
 *   start    — the hooks. Under an exclusive-create lock: a live holder with a fresh
 *              heartbeat → no-op (a connect replaces it); otherwise spawn `run`.
 *              The watchdog (`bridge-watchdog.mjs`, DX-3997) runs it as a subprocess
 *              with `--restart-trigger=watchdog [--consume-stop-instance=<id>]`: that
 *              forces the resume intent, skips the plan-connection gate (the watchdog
 *              already decided from the session's own `.connected.json`), and has
 *              `start` record the restart for the crash-loop guard (see
 *              `parseStartFlags` / `resolveStartRequest`).
 *   run      — the bridge: supervises the subcommand and relays its events.
 *   stop     — SessionEnd. Signals a live holder, whose SIGTERM handler ends its child.
 *
 * THE WATCHDOG IS NOT HERE. The PostToolUse/Stop restart check lives in
 * `bridge-watchdog.mjs` and never imports this file: the code that restarts a dead
 * bridge must not share a failure with it (a corrupted copy of this file once silenced
 * both). This file writes the state the watchdog reads; the shared state-file plumbing
 * is `lib/bridge-state.mjs`, the pure restart decision `lib/bridge-restart-decision.mjs`.
 *
 * STATE lives under `${CLAUDE_PLUGIN_DATA}/plan-event-bridge/`, per session: pid, lock,
 * cursor, log, the last stop record, and the watchdog's started/connected/throttle
 * markers (see `sessionPaths`). Every write is write-then-rename; files untouched for
 * STALE_STATE_MS are pruned.
 */

import { spawn, spawnSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { VersionError, requireRecordedSpec, versionFor } from "./lib/dashboard-mcp-package.mjs";
import { isPlanConnected } from "./lib/plan-connection.mjs";
import { HEALTHY_RUN_MS, HEARTBEAT_STALE_MS, readJsonFile, sessionPaths, stateDir, writeFileAtomic } from "./lib/bridge-state.mjs";
import { effectiveRestartGeneration } from "./lib/bridge-restart-decision.mjs";
import { parseHookPayload, readStdinText } from "./lib/hook-input.mjs";
import { RELAY_MARKER, failureNotice, versionKeptNotice } from "./lib/failure-notice.mjs";

export const BRIDGE_SUBCOMMAND = "bridge";

export const HEARTBEAT_MS = 30_000;
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

/** Prefix of every relayed dashboard event: the tag alone. */
export const RELAY_PREFIX = RELAY_MARKER;

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

// DX-3028/DX-2953: every state-file suffix must be listed here so `pruneStale` reaches it.
// DX-3284: also the suffix of activity-report.mjs's failure trace, which prunes its own directory with this.
export const STATE_SUFFIXES = [".pid.json", ".lock", ".cursor.json", ".log", ".stopped.json", ".started.json", ".connected.json", ".watchdog.json", ".last-failure.json", ".tmp"];

// ------------------------------------------------------------------ state files
// DX-3997: stateDir / sessionPaths / readJsonFile / writeFileAtomic live in lib/bridge-state.mjs.

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

// ------------------------------------------- DX-2953: the markers the watchdog reads

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
 * session is bound to a plan, nor does `credential_unavailable` (DX-4391: a signed-out
 * session whose key is gone), and every `bridge_failed` record this plugin
 * ever persists (see `start()`'s `spawnRun` catch and `run()`'s own
 * liveness-check fatal paths) is, by construction, a failure that happened
 * BEFORE any mint was attempted — none of these four prove the session is
 * bound. Every other reason (including `not_connected`, which instead
 * writes `connected:false`) reaches a mint or a stream, so it DOES prove
 * binding.
 */
export const CONNECTED_WRITE_SKIP_REASONS = new Set(["no_connection_record", "credential_unavailable", "session_is_worker", "bridge_failed"]);

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
export async function announce({ reason, fix, notice = failureNotice(reason, fix), env, post = postToInbox, stderr = () => {}, relevant = true }) {
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
 *
 * Injectable for tests: `spawnRun`, `isAlive`, `killTree`, `now`, `waitVerdict`, `verdictTimeoutMs`,
 * `post`, `stderr` and (DX-4321) `versionForFn`, the version rule of lib/dashboard-mcp-package.mjs.
 */
export async function start({
  env = process.env,
  sessionId,
  intent = RESUME_INTENT,
  post = postToInbox,
  stderr = writeStderr,
  // DX-4321: true for a SessionStart hook, which refreshes the recorded danx-dashboard-mcp version; every other start reads the record.
  sessionStart = false,
  versionForFn = versionFor,
  ...rest
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
  const resolved = { env, sessionId, intent, post, stderr };
  const version = await prepareDashboardMcpVersion({ ...resolved, sessionStart, versionForFn });
  if (version.refusal) return version.refusal;
  const result = await startBridge({ ...resolved, ...rest });
  return { ...result, exitCode: Math.max(result.exitCode ?? 0, version.exitCode) };
}

const writeStderr = (message) => process.stderr.write(message);

/**
 * DX-4321: the version of the danx-dashboard-mcp package this start runs, decided by the one rule in
 * lib/dashboard-mcp-package.mjs (`versionFor`): a SessionStart (`sessionStart`) refreshes it, any other
 * start reads the record. Takes start()'s already-resolved values. Returns `{exitCode}` (2 only when a
 * notice could not reach the inbox and went to stderr for asyncRewake), or `{refusal}`, a start() result,
 * when there is no version at all and nothing can run.
 */
async function prepareDashboardMcpVersion({ env, sessionId, intent, post, stderr, sessionStart, versionForFn }) {
  const relevant = isSessionKnownToWantEvents({ intent, env, sessionId });
  let outcome;
  try {
    outcome = await versionForFn({ sessionStart, env });
  } catch (err) {
    if (!(err instanceof VersionError)) throw err; // only a failure to obtain a version is announced; a bug is not
    const announced = await announce({
      reason: err.message,
      fix: `${err.fix}, then call plan_connect again in this session`,
      env,
      post,
      stderr,
      relevant,
    });
    return { refusal: { started: false, reason: err.message, exitCode: announced.exitCode } };
  }
  if (outcome.keptLine === null) return { exitCode: 0 };
  // The refresh failed but the recorded version keeps running: tell the session, once, which one.
  const told = await announce({ notice: versionKeptNotice(outcome.keptLine), env, post, stderr, relevant });
  return { exitCode: told.exitCode };
}

// `start` has resolved every default and checked what the bridge needs (session id, env) before this runs.
async function startBridge({
  env,
  sessionId,
  intent,
  post,
  stderr,
  spawnRun = spawnRunProcess,
  isAlive: alive = isAlive,
  killTree: kill = killTree,
  now = Date.now,
  waitVerdict = waitForVerdict,
  verdictTimeoutMs = STARTUP_VERDICT_MS,
  // DX-2953: recorded into .started.json's startInputs so a watchdog restart reuses it.
  transcriptPath = null,
  // DX-2953 / DX-3997: set only by `start --restart-trigger=watchdog` (run by bridge-watchdog.mjs); selects generation-bump behavior in buildStartedRecord.
  restartTrigger,
  consumeStopInstance = null,
}) {
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
    // DX-3028: this instance's identity, minted under the lock right before spawning.
    const instanceId = randomUUID();
    const nowMs = now();
    // DX-2953: a spawnRun throw is caught here (inside the lock) so the failure is still
    // visible to the watchdog as a bridge_failed record — no run() process exists to report it otherwise.
    try {
      child = spawnRun(sessionId, runEnv(env, instanceId, transcriptPath), intent);
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
    // DX-2953: .started.json is start()'s own marker, written under the same lock either way.
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

/**
 * The run process's environment: `start()`'s own env plus this instance's id and,
 * when the hook input carried one, the session's `transcript_path` as
 * DANX_BRIDGE_TRANSCRIPT_PATH — danxbot DX-2954: the bridge subcommand (which gets
 * this env through `childEnv`) tails that transcript and sends the session's
 * stats in its dashboard heartbeat. A path inherited from this process's own env
 * is never passed on: it belongs to whatever session set it, not this one.
 */
export function runEnv(env, instanceId, transcriptPath) {
  const out = { ...env, DANX_BRIDGE_INSTANCE_ID: instanceId };
  delete out.DANX_BRIDGE_TRANSCRIPT_PATH;
  if (transcriptPath) out.DANX_BRIDGE_TRANSCRIPT_PATH = transcriptPath;
  return out;
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
export function bridgeCommand({ resumeIds, spec, platform = process.platform, execPath = process.execPath, exists = fs.existsSync }) {
  // DX-4321: `spec` is `<name>@<recorded version>` (lib/dashboard-mcp-package.mjs), never a literal here.
  const args = ["-y", spec, BRIDGE_SUBCOMMAND, ...resumeArgs(resumeIds)];
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
    // DX-3028: a record missing `degraded` (pre-DX-3028 subcommand) defaults to false (exit).
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
  // DX-2862: "ready" is what `start` waits for, so a hook can report a failed start rather
  // than exiting 0 over a bridge that never worked. DX-3059: `boards === null` (inventory
  // read failed) is kept distinct from `boards: []` (read succeeded, none visible).
  if (record?.type === "ready") {
    return {
      kind: "ready",
      boards: record.boards === null ? null : Array.isArray(record.boards) ? record.boards.map(String) : [],
      cardCount: Number.isSafeInteger(record.cardCount) && record.cardCount >= 0 ? record.cardCount : null,
      degraded: record.degraded === true,
      // DX-3928 / DX-3912: the server's own reason the inventory read failed (null when it did not).
      inventoryError: typeof record.inventoryError === "string" && record.inventoryError !== "" ? record.inventoryError : null,
    };
  }
  return { kind: "junk" };
}

/**
 * DX-3059: the server's own `degraded` flag conflates "no board visible" (real problem)
 * with "boards known but plan has 0 cards" (benign) — this reads `boards` itself to tell
 * them apart: `null` = inventory read failed, `[]` = read ok but no board visible,
 * non-empty = real boards known (an old subcommand sending none of these fields falls
 * into the same "no boards known" shape on purpose, matching the failure DX-2970 closes).
 */
export function describeReadyRecord(record) {
  const boards = record.boards;
  const cardCount = record.cardCount;
  if (!Array.isArray(boards) || boards.length === 0) {
    const why =
      boards === null
        ? "the plan inventory read failed (network/timeout/bad response), so nothing is known"
        : "this session's credential cannot see any board of the connected plan";
    // DX-3928: the server's own failure text, when it sent one (null prints nothing extra).
    const reason = typeof record.inventoryError === "string" && record.inventoryError !== "" ? ` (${record.inventoryError})` : "";
    return (
      `DEGRADED — ${why}${reason}. The bridge is streaming, but it may be relaying nothing. ` +
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
          // DX-2953: a real relayed event is the only proof a degraded child recovered
          // (bridge.ts never re-emits "ready"); clearing here lets a later hard-kill restart.
          onEvent();
        } else if (record.kind === "stopped") {
          const full = { reason: record.reason, detail: record.detail, fix: record.fix, paths: record.paths, instanceId: record.instanceId, degraded: record.degraded };
          onStopped(full);
          // DX-3028: a DEGRADED record does not end this promise — the child stays alive,
          // so this keeps waiting on the real `child.on("close")` below.
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

/** Exit code for a shutdown — FATAL vs a normal stop, distinguishable by exit code alone. */
export function exitCodeForShutdown(fatal) {
  return fatal ? 1 : 0;
}

/** `run()`'s two terminal events (relay-queue overflow, always fatal; or superviseBridge's
 * own resolution), mapped to `{why, fatal}` for `shutdown()`. */
export function terminalShutdown(event) {
  if ("overflow" in event) return { why: event.overflow, fatal: true };
  return { why: event.supervised.reason, fatal: event.supervised.fatal };
}

/** The real bridge subcommand child. Injectable (`run()`'s `spawnSubcommand`) so tests can
 * replace it with a stand-in that never touches the network. */
function defaultSpawnSubcommand({ resumeIds, env }) {
  const { command, args } = bridgeCommand({ resumeIds, spec: requireRecordedSpec(env) });
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
  // DX-2862: whether this session is known to want plan events decides whether a failure
  // is put in front of it or only logged.
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
    // DX-2894: clear the self-rescheduling start-key timer so "shutdown stops every timer" is
    // an invariant of the function, not an accident of how Node tears down on exit.
    if (startKeyTimer) clearTimeout(startKeyTimer);
    if (child) killTree(child.pid);
    if (readJsonFile(paths.pid)?.pid === process.pid) fs.rmSync(paths.pid, { force: true });
    process.exit(exitCodeForShutdown(fatal));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(`received ${signal}`));

  // DX-2953: `start()` always sets DANX_BRIDGE_INSTANCE_ID, so a missing one is a plugin bug,
  // not a session condition — refuse loudly rather than minting a fresh id here.
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

  /** DX-2953: every pre-ready fatal startup path writes a bridge_failed record naming its
   * instance before exiting — the only way the watchdog learns this instance never got
   * anywhere and applies its crash-loop guard instead of restarting every 60s forever. */
  const persistBridgeFailed = (detail, fix) => {
    try {
      persistStopRecord(paths.stopped, { reason: "bridge_failed", detail, fix: fix ?? "", paths: [], instanceId: "", degraded: false }, instanceId, Date.now());
    } catch (err) {
      log(`could not persist the bridge_failed stop record: ${err.message}`);
    }
  };

  // DX-2894: the bridge's own check of its Claude process is the SOLE liveness authority
  // (SessionEnd only makes shutdown faster). CLAUDE_PID is undocumented — a missing/invalid
  // value is a loud refusal to start. Every check below runs BEFORE any state that claims
  // this bridge for the session.
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
  // DX-2894: a parent already dead at startup takes the normal "exited" stop, never the
  // "could not read start time" fatal refusal (reserved for a LIVE unreadable pid).
  if (!alive(parentPid)) {
    shutdown(`Claude Code process ${parentPid} exited`);
    return;
  }
  // Record the parent's start time so a later pid reuse is detectable — a bare kill(pid, 0)
  // can't tell the two apart. Track the real error so the fatal notice below can name it.
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
    // DX-2894: the parent can die between the alive() check above and this read returning —
    // re-check liveness so an ordinary "session ended" isn't misreported as a fatal refusal.
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

  // DX-2953: `instanceId` was resolved once, loudly, near the top of this function.
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
  // `verifyStartKeyTick` for the full decision table.
  //
  // DX-2894: a self-rescheduling `setTimeout`, never `setInterval`, keeps checks strictly
  // non-overlapping — a plain interval could let two async OS reads race the same
  // `unreadableCount` closure variable.
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
          // DX-2894: a bug in the tick itself (never an ordinary start-key read failure) must
          // still end the bridge and reach the session; swallow a tellSession failure so it
          // never skips the shutdown below.
          const reason = `start-key verification failed unexpectedly: ${describeProcessError(err)}`;
          await tellSession(reason, "restart the session so the plugin can observe CLAUDE_PID again").catch((tellErr) => {
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

  // DX-2953: `.connected.json` is this run process's own marker, fenced on `.pid.json`'s
  // instanceId still matching this process's — a superseded run can never clobber a fresher one.
  const writeConnected = (connected) => {
    try {
      const result = writeConnectedIfCurrent(paths, { connected, instanceId, now: Date.now() });
      if (!result.written) log(`skipped writing the connected marker (connected=${connected}): another instance now owns .pid.json`);
    } catch (err) {
      log(`could not write the connected marker: ${err.message}`);
    }
  };
  /** DX-2953: a bridge reaching ready, or recovering from degraded, deletes its own stop
   * record — otherwise a resolved degraded record would linger as "applicable" later. */
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
      // DX-3059: describeReadyRecord tells degraded/empty/populated apart — see its own doc comment.
      log(describeReadyRecord(record));
      // DX-2953: reaching ready proves the session is bound to a plan; retire any stop record.
      clearStopRecord();
      writeConnected(true);
      sendVerdict({ verdict: "ready" });
    },
    // DX-3028: persisted the moment the child reports it (not only once this process
    // terminates), since DX-2953's watchdog reads this file as soon as the child says so.
    onStopped: (record) => {
      log(`bridge subcommand reported ${record.reason}${record.degraded ? " (degraded — staying alive)" : ""}: ${record.detail}`);
      try {
        persistStopRecord(paths.stopped, record, instanceId);
      } catch (err) {
        log(`could not persist the stop record: ${err.message}`);
      }
      // DX-2953: instance-id drift detection — the watchdog never trusts this field (it
      // matches on writingInstanceId alone); this just makes real drift visible in the log.
      if (record.instanceId && record.instanceId !== instanceId) {
        log(`instance id drift: the stop record's own instanceId (${record.instanceId}) differs from this run process's writingInstanceId (${instanceId})`);
      }
      // DX-2953: not_connected writes connected:false; every other non-skipped reason
      // (CONNECTED_WRITE_SKIP_REASONS) proves the session IS bound, so it writes connected:true.
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

/**
 * Whether a hook's `start` may spawn anything (DX-3392 problems 1762/1764, PLN-11
 * R-10). A `plan_connect` always may; a SessionStart only for a session already
 * plan-connected, so the many sessions that never touch a plan spawn nothing.
 */
export function hookMayStart({ intent, sessionId, env = process.env, connected = isPlanConnected }) {
  if (intent === CONNECT_INTENT) return true;
  return connected(sessionId, env.DANXBOT_PLAN_SESSIONS_HOME || homedir());
}

/** The hook's stdin JSON carries `session_id`, `hook_event_name` and `transcript_path`; a hand run has none. */
async function readHookInput() {
  const hook = parseHookPayload(await readStdinText());
  // DX-2953: transcriptPath is recorded into .started.json's startInputs so a watchdog restart reuses it.
  // DX-4321: sessionStart is the one event that refreshes the recorded danx-dashboard-mcp version.
  return { sessionId: hook.sessionId, intent: intentFromHookEvent(hook.hookEventName), transcriptPath: hook.transcriptPath, sessionStart: hook.hookEventName === "SessionStart" };
}

/** DX-3997: the only restart trigger `start` accepts — `bridge-watchdog.mjs` runs `start` as a subprocess with it. */
export const WATCHDOG_TRIGGER = "watchdog";

/**
 * DX-3997 — the CLI surface the watchdog's subprocess uses: `start --restart-trigger=watchdog
 * [--consume-stop-instance=<id>]`. Fails loud on anything else (a typo here would otherwise
 * silently start the bridge as a plain connect and reset the crash-loop guard).
 */
export function parseStartFlags(args) {
  const flags = { restartTrigger: undefined, consumeStopInstance: null };
  for (const arg of args) {
    const match = /^--(restart-trigger|consume-stop-instance)=(.+)$/.exec(arg);
    if (!match) throw new Error(`unknown start argument ${JSON.stringify(arg)}`);
    if (match[1] === "restart-trigger") {
      if (match[2] !== WATCHDOG_TRIGGER) throw new Error(`--restart-trigger only accepts ${WATCHDOG_TRIGGER}, got ${JSON.stringify(match[2])}`);
      flags.restartTrigger = match[2];
    } else {
      flags.consumeStopInstance = match[2];
    }
  }
  if (flags.consumeStopInstance !== null && flags.restartTrigger !== WATCHDOG_TRIGGER) {
    throw new Error("--consume-stop-instance needs --restart-trigger=watchdog");
  }
  return flags;
}

/**
 * What `start` mode hands to `start()`. A watchdog restart is ALWAYS the resume intent (the
 * hook payload it is run with is a PostToolUse/Stop one, whose event name would otherwise read
 * as a plan_connect) and skips the plan-connection gate: the watchdog already decided from the
 * session's own `.connected.json`, as the in-process call did before DX-3997.
 */
export function resolveStartRequest({ hook, flags }) {
  const isWatchdog = flags.restartTrigger === WATCHDOG_TRIGGER;
  return {
    sessionId: hook.sessionId,
    intent: isWatchdog ? RESUME_INTENT : hook.intent,
    transcriptPath: hook.transcriptPath,
    sessionStart: !isWatchdog && hook.sessionStart === true,
    restartTrigger: flags.restartTrigger,
    consumeStopInstance: flags.consumeStopInstance,
    gated: !isWatchdog,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [mode, arg, intentArg] = process.argv.slice(2);
  const modes = {
    start: async () => {
      const flags = parseStartFlags(process.argv.slice(3));
      const hook = await readHookInput();
      const request = resolveStartRequest({ hook, flags });
      if (request.gated && !hookMayStart({ intent: request.intent, sessionId: request.sessionId })) process.exit(0);
      const { gated: _gated, ...startArgs } = request;
      const result = await start(startArgs);
      process.exit(result.exitCode ?? 0);
    },
    stop: async () => {
      const hook = await readHookInput();
      stop({ sessionId: hook.sessionId });
      process.exit(0);
    },
    run: () => run(arg, intentArg),
  };
  const main = modes[mode];
  if (!main) {
    process.stderr.write("usage: plan-event-bridge.mjs start|stop|run <session-id>\n");
    process.exit(2);
  }
  Promise.resolve()
    .then(main)
    .catch((err) => {
      process.stderr.write(`danxbot plan event bridge ${mode} failed: ${err.message}\n`);
      process.exit(1);
    });
}
