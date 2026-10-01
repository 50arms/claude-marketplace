#!/usr/bin/env node
/**
 * danxbot plan event bridge watchdog (DX-2953, moved out of the bridge by DX-3997).
 *
 * WHAT RUNS IT. `PostToolUse` (all tools) and `Stop`, with `asyncRewake`: exit 2 plus stderr
 * wakes the model, exit 0 is silent. Every tick but one per WATCHDOG_THROTTLE_MS is a single
 * `fs.statSync` and an immediate exit with no output.
 *
 * WHY IT IS NOT IN `plan-event-bridge.mjs`. On 2026-10-01 a machine crash zeroed that file;
 * every hook that ran it failed silently, and the watchdog — then a mode INSIDE it — could not
 * restart anything. So this file, and every module it imports, is independent of the bridge:
 * it imports only `lib/` modules and `node:` built-ins, never `plan-event-bridge.mjs`
 * (a source-scan test holds that). When a restart is due it runs the bridge's own `start` as a
 * SUBPROCESS and relays its exit code and output; if that subprocess cannot even run (crashed,
 * or its script will not load) the watchdog says so loudly instead of going silent.
 *
 * WHAT IT OWNS. The throttle stamp, the tick orchestration, and (via `lib/`) the pure restart
 * decision. The state it reads is what the bridge writes: `.pid.json` (staleness),
 * `.started.json`, `.connected.json`, `.stopped.json` — see `lib/bridge-state.mjs`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_STALE_MS, WATCHDOG_THROTTLE_MS, readJsonFile, sessionPaths, stateDir, writeFileAtomic } from "./lib/bridge-state.mjs";
import { shouldWatchdogRestart } from "./lib/bridge-restart-decision.mjs";
import { failureNotice } from "./lib/failure-notice.mjs";
import { parseHookPayload, readStdinText } from "./lib/hook-input.mjs";

/** The bridge script the watchdog runs `start` from — a sibling file, run, never imported. */
export const BRIDGE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "plan-event-bridge.mjs");

/** The one exit code `plan-event-bridge.mjs start` uses deliberately (a failure it could not put in the session's inbox). */
const START_DELIBERATE_FAILURE_EXIT = 2;
/** How much of the subprocess's stderr the loud notice quotes. */
export const STDERR_QUOTE_CHARS = 300;

export const CORRUPT_INSTALL_FIX = "the danxbot plugin install may be corrupt: run `update-claude-plugins` and restart the session";

/**
 * Run `plan-event-bridge.mjs start --restart-trigger=watchdog ...` as a subprocess with the
 * hook's payload on its stdin. Resolves `{code, signal, stdout, stderr, spawnError}`; never rejects.
 */
export function runBridgeStart({ bridgeScript = BRIDGE_SCRIPT, args, input, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [bridgeScript, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", spawnError: err.message });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.stdin.on("error", () => {
      /* the child exited before reading its input — its exit code says why */
    });
    child.on("error", (e) => resolve({ code: null, signal: null, stdout: "", stderr: "", spawnError: e.message }));
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), spawnError: null }),
    );
    child.stdin.end(input);
  });
}

/**
 * What the watchdog's own hook output and exit code are, given how the `start` subprocess ended.
 * 0 and its deliberate 2 pass straight through (its stderr is already the failure notice
 * `asyncRewake` shows); anything else means `start` itself could not run — never silent.
 */
export function interpretStartOutcome(outcome) {
  const { code, signal, stdout = "", stderr = "", spawnError = null } = outcome;
  if (!spawnError && (code === 0 || code === START_DELIBERATE_FAILURE_EXIT)) {
    return { exitCode: code, stdout, stderr };
  }
  const how = spawnError ? `could not be run (${spawnError})` : code === null ? `was killed by ${signal}` : `exited ${code}`;
  // The error line itself (a load failure prints the offending source line and a stack around it), else the last line.
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const quote = (lines.find((line) => /Error\b/.test(line)) ?? lines.at(-1) ?? "").slice(0, STDERR_QUOTE_CHARS);
  const reason = `the watchdog could not restart it: \`plan-event-bridge.mjs start\` ${how}${quote ? ` — stderr: ${quote}` : ""}`;
  return { exitCode: START_DELIBERATE_FAILURE_EXIT, stdout, stderr: `${failureNotice(reason, CORRUPT_INSTALL_FIX)}\n` };
}

/**
 * One watchdog tick. Throttled to once per `throttleMs` via `paths.watchdog`'s own mtime. On
 * an actual tick: refresh the throttle stamp, `utimesSync` both marker files (the named toucher
 * that keeps the bridge's `pruneStale` from reclaiming a live session's markers), read the four
 * state files and hand them to the pure `shouldWatchdogRestart`. Only when it says to restart
 * does this run the bridge's `start` (`runStart`, a subprocess by default) — the healthy path
 * spawns nothing and prints nothing.
 *
 * Returns `{ticked, restartAttempted, reason?, startOutcome?, exitCode, stdout, stderr}`; the caller
 * prints `stdout`/`stderr` and exits with `exitCode`.
 */
export async function watchdogTick({
  env = process.env,
  sessionId,
  hookText = "",
  now = Date.now,
  throttleMs = WATCHDOG_THROTTLE_MS,
  heartbeatStaleMs = HEARTBEAT_STALE_MS,
  bridgeScript = BRIDGE_SCRIPT,
  runStart = runBridgeStart,
} = {}) {
  const quiet = { ticked: false, restartAttempted: false, exitCode: 0, stdout: "", stderr: "" };
  if (!env.CLAUDE_PLUGIN_DATA || typeof sessionId !== "string" || sessionId === "") return quiet;
  const paths = sessionPaths(stateDir(env), sessionId);
  const nowMs = now();
  let throttleAge = Infinity;
  try {
    throttleAge = nowMs - fs.statSync(paths.watchdog).mtimeMs;
  } catch {
    /* never ticked before — a fresh tick is due */
  }
  if (throttleAge < throttleMs) return quiet;
  writeFileAtomic(paths.watchdog, JSON.stringify({ lastTickAt: new Date(nowMs).toISOString() }));
  // DX-2953: stamp mtimes to the injected `now`, not the real OS clock, so every timing
  // decision in this module stays deterministic under an injected clock.
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
  if (!decision.restart) return { ...quiet, ticked: true, reason: decision.reason };

  // DX-3997: `start` (intent resume, the hook's own transcript_path, the watchdog trigger and
  // the stop record to consume) is run as a subprocess — see the file docblock.
  const args = ["start", "--restart-trigger=watchdog", ...(decision.consumeStopInstance ? [`--consume-stop-instance=${decision.consumeStopInstance}`] : [])];
  const startOutcome = await runStart({ bridgeScript, args, input: hookText, env });
  const result = interpretStartOutcome(startOutcome);
  return { ticked: true, restartAttempted: true, reason: decision.reason, startOutcome, ...result };
}

/** Write then exit once the write has flushed, so a piped stderr is never cut off. */
function writeThenExit(text, code) {
  if (!text) process.exit(code);
  process.stderr.write(text, () => process.exit(code));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const hookText = await readStdinText();
    const hook = parseHookPayload(hookText);
    const result = await watchdogTick({ sessionId: hook.sessionId, hookText });
    if (result.stdout) process.stdout.write(result.stdout);
    writeThenExit(result.stderr, result.exitCode);
  })().catch((err) => {
    process.stderr.write(`danxbot plan event bridge watchdog failed: ${err.message}\n`);
    process.exit(1);
  });
}
