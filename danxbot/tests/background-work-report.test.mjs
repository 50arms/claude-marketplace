// danxbot background-work report hook — Stop/SubagentStop/SessionStart/
// StopFailure/PostToolUse(.*) heartbeat. DX-3367 (+ review fix-up). Run with
// `npm test` (node --test).
//
// Functional behavior (stop/subagent-stop/session-start/stop-failure/
// heartbeat) is tested by importing the mode handlers directly and injecting
// a fake `spawnFn` — mirroring plan-event-bridge.test.mjs's injected
// `spawnRun` — so no test ever shells out to a real `npx` (network, slow,
// non-deterministic). Only the input-robustness cases that never reach a
// spawn at all (malformed/empty stdin, an unknown mode) are exercised as a
// real subprocess, to also prove the CLI's argv/stdin wiring.
//
// PLAN-CONNECTION GATE (review finding 1): every functional test now runs
// against an ISOLATED `DANXBOT_PLAN_SESSIONS_HOME` (never the operator's
// real `~/.config/danxbot/plan-sessions/`) and calls `connect(sessionId)`
// before any test that expects a spawn to occur — mirroring
// `plan-connection.test.mjs`'s own fixture. A session never `connect()`-ed
// is the "not plan-connected" case and must never spawn.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_MCP_PACKAGE,
  REPORT_SPAWN_TIMEOUT_MS,
  HEARTBEAT_THROTTLE_MS,
  isValidSessionId,
  countFromSnapshot,
  reportCommand,
  childEnv,
  stateDir,
  sessionPaths,
  runReport,
  runClear,
  runHeartbeat,
  dispatchMode,
} from "../scripts/background-work-report.mjs";
import { childEnv as bridgeChildEnv } from "../scripts/plan-event-bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "background-work-report.mjs");
const HOOKS_JSON = JSON.parse(readFileSync(path.join(here, "..", "hooks", "hooks.json"), "utf8"));

let pluginData;
let planHome;
beforeEach(() => {
  pluginData = mkdtempSync(path.join(tmpdir(), "background-work-report-test-"));
  planHome = mkdtempSync(path.join(tmpdir(), "background-work-report-planhome-"));
});
afterEach(() => {
  rmSync(pluginData, { recursive: true, force: true });
  rmSync(planHome, { recursive: true, force: true });
});

function stateFile(sessionId) {
  return path.join(pluginData, "background-work", `${sessionId}.json`);
}

function heartbeatStampFile(sessionId) {
  return path.join(pluginData, "background-work", `${sessionId}.heartbeat.json`);
}

/** Writes the same connection record `plan_connect` writes, so `isPlanConnected` reads this session as connected (mirrors plan-connection.test.mjs's own `connect`). */
function connect(sessionId, home = planHome) {
  const dir = path.join(home, ".config", "danxbot", "plan-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1 }));
}

/** The env every functional test passes: plugin data dir + an ISOLATED plan-sessions home (never the operator's real one). */
const env = () => ({ CLAUDE_PLUGIN_DATA: pluginData, DANXBOT_PLAN_SESSIONS_HOME: planHome });

/**
 * A `spawnFn` stand-in that never touches a real process — records every
 * call and, by default, echoes back a realistic `{ok:true, count}` success
 * outcome (mirrors what `background-work.ts`'s subcommand actually prints:
 * "on success, `{ok:true, count:<number|null>}` echoes what was stored").
 */
function fakeSpawn(calls, { stdout } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    if (stdout !== undefined) return { status: 0, stdout, stderr: "" };
    const countArg = args[args.length - 1];
    const echoed = { ok: true, count: countArg === "clear" ? null : Number(countArg) };
    return { status: 0, stdout: JSON.stringify(echoed), stderr: "" };
  };
}

/** A `spawnFn` stand-in for a subcommand that ran but reported failure (e.g. unauthorized, timeout). */
function failingSpawn(calls, reason = "unauthorized") {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    return { status: 0, stdout: JSON.stringify({ ok: false, reason }), stderr: "" };
  };
}

// --------------------------------------------------------------- pure logic

describe("isValidSessionId (re-exported from lib/plan-connection.mjs)", () => {
  test("accepts a real session id shape", () => {
    assert.equal(isValidSessionId("eae1b219-a47a-471b-9081-563a31c5476f"), true);
  });
  test("rejects path traversal / non-string / missing", () => {
    assert.equal(isValidSessionId("../../etc/passwd"), false);
    assert.equal(isValidSessionId(""), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId(42), false);
  });
});

describe("countFromSnapshot — pure logic", () => {
  test("absent field (not an array at all) is null, never guessed as 0", () => {
    assert.equal(countFromSnapshot(undefined), null);
    assert.equal(countFromSnapshot(null), null);
    assert.equal(countFromSnapshot("not-an-array"), null);
  });
  test("empty array is a trusted 0", () => {
    assert.equal(countFromSnapshot([]), 0);
  });
  test("counts only RUNNING shell/subagent/workflow entries", () => {
    const tasks = [
      { type: "shell", status: "running" },
      { type: "subagent", status: "running" },
      { type: "workflow", status: "running" },
      { type: "monitor", status: "running" },
      { type: "teammate", status: "running" },
      { type: "cloud session", status: "running" },
      { type: "MCP task", status: "running" },
    ];
    assert.equal(countFromSnapshot(tasks), 3);
  });
  test("a counted type that is NOT running is excluded — a trusted 0, not unknown", () => {
    assert.equal(countFromSnapshot([{ type: "shell", status: "pending" }]), 0);
    assert.equal(countFromSnapshot([{ type: "subagent" /* no status at all */ }]), 0);
  });
  test("an unrecognized type makes the WHOLE snapshot unknown (null), never a guessed 0", () => {
    assert.equal(countFromSnapshot([{ type: "future-type-nobody-has-heard-of", status: "running" }]), null);
  });
  test("a missing type on any entry makes the whole snapshot unknown", () => {
    assert.equal(countFromSnapshot([{ status: "running" }]), null);
    assert.equal(countFromSnapshot([{ type: null, status: "running" }]), null);
  });
  test("one unrecognized-type entry poisons the count even alongside otherwise-countable entries", () => {
    assert.equal(countFromSnapshot([{ type: "shell", status: "running" }, { type: "some-new-type" }]), null);
  });
});

describe("reportCommand — spawn shape (mirrors plan-event-bridge.mjs's bridgeCommand)", () => {
  test("non-windows spawns npx directly with the pinned package + subcommand + count", () => {
    assert.deepEqual(reportCommand({ countOrClear: "3", platform: "linux" }), {
      command: "npx",
      args: ["-y", DASHBOARD_MCP_PACKAGE, "background-work", "3"],
    });
  });
  test("windows routes through node_modules/npm/bin/npx-cli.js next to execPath", () => {
    const execPath = "C:\\node\\node.exe";
    const npxCli = path.join("C:\\node", "node_modules", "npm", "bin", "npx-cli.js");
    const result = reportCommand({ countOrClear: "clear", platform: "win32", execPath, exists: (p) => p === npxCli });
    assert.deepEqual(result, { command: execPath, args: [npxCli, "-y", DASHBOARD_MCP_PACKAGE, "background-work", "clear"] });
  });
  test("windows throws loud when npx-cli.js is missing, rather than spawning something broken", () => {
    assert.throws(() => reportCommand({ countOrClear: "1", platform: "win32", execPath: "C:\\node\\node.exe", exists: () => false }), /npx not found/);
  });
});

describe("childEnv — reused from plan-event-bridge.mjs (review finding 6)", () => {
  test("is literally the bridge's own export, not a re-implementation", () => {
    assert.equal(childEnv, bridgeChildEnv);
  });
  test("sets CLAUDE_CODE_SESSION_ID onto a copy of the given env", () => {
    const base = { FOO: "bar" };
    const out = childEnv(base, "sess-1");
    assert.equal(out.CLAUDE_CODE_SESSION_ID, "sess-1");
    assert.equal(out.FOO, "bar");
    assert.equal(base.CLAUDE_CODE_SESSION_ID, undefined); // original untouched
  });
  test("strips CLAUDE_CODE_MESSAGING_TOKEN and CLAUDE_CODE_MESSAGING_SOCKET", () => {
    const base = { CLAUDE_CODE_MESSAGING_TOKEN: "secret", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock", FOO: "bar" };
    const out = childEnv(base, "sess-1");
    assert.equal(out.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
    assert.equal(out.CLAUDE_CODE_MESSAGING_SOCKET, undefined);
    assert.equal(out.FOO, "bar");
  });
});

describe("stateDir / sessionPaths", () => {
  test("stateDir throws loud when CLAUDE_PLUGIN_DATA is unset", () => {
    assert.throws(() => stateDir({}), /CLAUDE_PLUGIN_DATA/);
  });
  test("sessionPaths refuses an unsafe session id rather than path-joining it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "background-work-report-paths-"));
    try {
      assert.throws(() => sessionPaths(dir, "../../evil"), /session id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------- plan-connection gate (finding 1)

describe("plan-connection gate — NEVER spawn for a session that isn't plan-connected", () => {
  test("runReport spawns nothing for an unconnected session", () => {
    const calls = [];
    runReport({ session_id: "not-connected-1", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(stateFile("not-connected-1")), false);
  });

  test("runClear spawns nothing for an unconnected session", () => {
    const calls = [];
    runClear({ session_id: "not-connected-2" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
  });

  test("runHeartbeat spawns nothing for an unconnected session, even with agent_id and a stored count", () => {
    const calls = [];
    connect("not-connected-3"); // connected while priming the state file...
    runReport({ session_id: "not-connected-3", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 1);
    calls.length = 0;
    rmSync(path.join(planHome, ".config", "danxbot", "plan-sessions", "not-connected-3.json")); // ...then disconnect
    runHeartbeat({ session_id: "not-connected-3", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
  });

  test("a connected session DOES spawn", () => {
    const calls = [];
    connect("connected-1");
    runReport({ session_id: "connected-1", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 1);
  });
});

// ------------------------------------------------------------- runReport (stop / subagent-stop)

describe("runReport — stop / subagent-stop", () => {
  test("known task types report a numeric count and persist {count, reportedAt, outcome}", () => {
    connect("sess-1");
    const calls = [];
    runReport(
      { session_id: "sess-1", background_tasks: [{ type: "shell", status: "running" }, { type: "monitor", status: "running" }, { type: "subagent", status: "running" }] },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_000_000 },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["-y", DASHBOARD_MCP_PACKAGE, "background-work", "2"]);
    assert.equal(calls[0].opts.env.CLAUDE_CODE_SESSION_ID, "sess-1");

    const state = JSON.parse(readFileSync(stateFile("sess-1"), "utf8"));
    assert.equal(state.count, 2);
    assert.equal(state.reportedAt, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(state.outcome, { ok: true, count: 2 });
  });

  test("missing background_tasks field reports+persists count:null as literal 'clear' (unknown, never guessed 0)", () => {
    connect("sess-2");
    const calls = [];
    runReport({ session_id: "sess-2" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.deepEqual(calls[0].args.slice(-1), ["clear"]);
    const state = JSON.parse(readFileSync(stateFile("sess-2"), "utf8"));
    assert.equal(state.count, null);
  });

  test("empty background_tasks array reports+persists a trusted count:0", () => {
    connect("sess-3");
    const calls = [];
    runReport({ session_id: "sess-3", background_tasks: [] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.deepEqual(calls[0].args.slice(-1), ["0"]);
    const state = JSON.parse(readFileSync(stateFile("sess-3"), "utf8"));
    assert.equal(state.count, 0);
  });

  test("invalid session id is refused, not path-joined: no spawn, no state dir", () => {
    const calls = [];
    runReport({ session_id: "../../evil", background_tasks: [] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(path.join(pluginData, "background-work")), false);
  });

  test("a spawn failure (e.g. npx missing) never throws out of runReport, and is never recorded as a reported count", () => {
    connect("sess-4");
    assert.doesNotThrow(() => {
      runReport(
        { session_id: "sess-4", background_tasks: [{ type: "shell", status: "running" }] },
        {
          env: env(),
          spawnFn: () => {
            throw new Error("boom");
          },
        },
      );
    });
    // Evidence is left (outcome), but count/reportedAt never advance — the
    // PUT never actually happened (DX-3367 review finding 3).
    const state = JSON.parse(readFileSync(stateFile("sess-4"), "utf8"));
    assert.equal(state.count, null);
    assert.equal(state.reportedAt, null);
    assert.equal(state.outcome.ok, false);
    assert.match(state.outcome.reason, /boom/);
  });

  test("a failed PUT (subcommand ran but reported ok:false) never advances count/reportedAt — but records the failure", () => {
    connect("sess-5");
    const calls = [];
    runReport({ session_id: "sess-5", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1000 });
    const before = JSON.parse(readFileSync(stateFile("sess-5"), "utf8"));
    assert.equal(before.count, 1);

    runReport(
      { session_id: "sess-5", background_tasks: [{ type: "shell", status: "running" }, { type: "shell", status: "running" }] },
      { env: env(), platform: "linux", spawnFn: failingSpawn(calls, "unauthorized"), now: () => 2000 },
    );

    const after = JSON.parse(readFileSync(stateFile("sess-5"), "utf8"));
    assert.equal(after.count, 1); // unchanged — the new count (2) was never actually confirmed stored
    assert.equal(after.reportedAt, before.reportedAt); // unchanged
    assert.deepEqual(after.outcome, { ok: false, reason: "unauthorized" }); // evidence recorded
  });

  test("the spawn pipes stdout and uses the documented timeout", () => {
    connect("sess-6");
    const calls = [];
    runReport({ session_id: "sess-6", background_tasks: [] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls[0].opts.timeout, REPORT_SPAWN_TIMEOUT_MS);
    assert.deepEqual(calls[0].opts.stdio, ["ignore", "pipe", "ignore"]);
  });
});

// -------------------------------------------------------- runClear (session-start / stop-failure)

describe("runClear — session-start / stop-failure", () => {
  test("always reports 'clear'", () => {
    connect("sess-7");
    const calls = [];
    runClear({ session_id: "sess-7" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.deepEqual(calls[0].args.slice(-1), ["clear"]);
  });

  test("removes an existing state file on a SUCCESSFUL clear", () => {
    connect("sess-8");
    const calls = [];
    runReport({ session_id: "sess-8", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(existsSync(stateFile("sess-8")), true);

    runClear({ session_id: "sess-8" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(existsSync(stateFile("sess-8")), false);
  });

  test("a FAILED clear does not remove the file — it looks like a clear happened, which would be false evidence", () => {
    connect("sess-9");
    const calls = [];
    runReport({ session_id: "sess-9", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1000 });
    const before = JSON.parse(readFileSync(stateFile("sess-9"), "utf8"));

    runClear({ session_id: "sess-9" }, { env: env(), platform: "linux", spawnFn: failingSpawn(calls, "timeout") });

    assert.equal(existsSync(stateFile("sess-9")), true);
    const after = JSON.parse(readFileSync(stateFile("sess-9"), "utf8"));
    assert.equal(after.count, before.count); // unchanged, never advanced to null on a failed clear
    assert.deepEqual(after.outcome, { ok: false, reason: "timeout" });
  });

  test("no prior state file is fine (force-remove) and never throws", () => {
    connect("sess-10");
    assert.doesNotThrow(() => runClear({ session_id: "sess-10" }, { env: env(), platform: "linux", spawnFn: fakeSpawn([]) }));
    assert.equal(existsSync(stateFile("sess-10")), false);
  });

  test("invalid session id is refused: no spawn", () => {
    const calls = [];
    runClear({ session_id: "../../evil" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
  });
});

// ------------------------------------------------------------------------- runHeartbeat

describe("runHeartbeat — PostToolUse(.*) no-op almost always", () => {
  test("no-op when agent_id is absent, even with a stored count", () => {
    connect("sess-11");
    const calls = [];
    runReport({ session_id: "sess-11", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    const before = readFileSync(stateFile("sess-11"), "utf8");

    runHeartbeat({ session_id: "sess-11" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_100_000 });
    assert.equal(calls.length, 1); // only the original runReport call
    assert.equal(existsSync(heartbeatStampFile("sess-11")), false);
    assert.equal(readFileSync(stateFile("sess-11"), "utf8"), before);
  });

  test("no-op when nothing was ever stored (agent_id present, no state file)", () => {
    connect("sess-12");
    const calls = [];
    runHeartbeat({ session_id: "sess-12", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(heartbeatStampFile("sess-12")), false);
  });

  test("no-op when last-cleared (state removed by session-start), even with agent_id present", () => {
    connect("sess-13");
    const calls = [];
    runReport({ session_id: "sess-13", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    runClear({ session_id: "sess-13" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    calls.length = 0;

    runHeartbeat({ session_id: "sess-13", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(heartbeatStampFile("sess-13")), false);
  });

  test("re-reports the stored count when due (no prior throttle stamp) and refreshes reportedAt", () => {
    connect("sess-14");
    const calls = [];
    runReport(
      { session_id: "sess-14", background_tasks: [{ type: "shell", status: "running" }, { type: "shell", status: "running" }] },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_000_000 },
    );
    const before = JSON.parse(readFileSync(stateFile("sess-14"), "utf8"));
    assert.equal(before.count, 2);
    calls.length = 0;

    runHeartbeat({ session_id: "sess-14", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_100_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-1), ["2"]); // same count, re-reported — never invented
    assert.equal(existsSync(heartbeatStampFile("sess-14")), true);

    const after = JSON.parse(readFileSync(stateFile("sess-14"), "utf8"));
    assert.equal(after.count, 2);
    assert.notEqual(after.reportedAt, before.reportedAt);
  });

  test("no-op when the throttle window has not elapsed", () => {
    connect("sess-15");
    const calls = [];
    runReport({ session_id: "sess-15", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 0 });
    runHeartbeat({ session_id: "sess-15", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 });
    assert.equal(calls.length, 2); // the initial report + the first (due) heartbeat tick

    // Well within HEARTBEAT_THROTTLE_MS of the first tick.
    runHeartbeat({ session_id: "sess-15", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 + HEARTBEAT_THROTTLE_MS - 1 });
    assert.equal(calls.length, 2); // unchanged — throttled
  });

  test("ticks again once the throttle stamp is aged past HEARTBEAT_THROTTLE_MS", () => {
    connect("sess-16");
    const calls = [];
    runReport({ session_id: "sess-16", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 0 });
    runHeartbeat({ session_id: "sess-16", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 });
    assert.equal(calls.length, 2);

    runHeartbeat(
      { session_id: "sess-16", agent_id: "agent-1" },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 + HEARTBEAT_THROTTLE_MS + 1 },
    );
    assert.equal(calls.length, 3); // ticked again
  });

  test("invalid session id is refused: no spawn, no throw", () => {
    const calls = [];
    assert.doesNotThrow(() => runHeartbeat({ session_id: "../../evil", agent_id: "x" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) }));
    assert.equal(calls.length, 0);
  });

  test("the heartbeat race: a fresher Stop/SubagentStop write landing WHILE the heartbeat's spawn is in flight is never clobbered (review finding 5)", () => {
    connect("sess-17");
    const calls = [];
    runReport(
      { session_id: "sess-17", background_tasks: [{ type: "shell", status: "running" }, { type: "shell", status: "running" }] },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_000_000 },
    );

    // A spawnFn that, once invoked, simulates a Stop hook landing a fresher
    // (zero) count WHILE this heartbeat's own report is still "in flight" —
    // i.e. before this heartbeat's own state-file write happens.
    const racySpawn = (command, args, opts) => {
      runReport({ session_id: "sess-17", background_tasks: [] }, { env: env(), platform: "linux", spawnFn: fakeSpawn([]), now: () => 1_700_000_050_000 });
      calls.push({ command, args, opts });
      return { status: 0, stdout: JSON.stringify({ ok: true, count: 2 }), stderr: "" };
    };

    runHeartbeat({ session_id: "sess-17", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: racySpawn, now: () => 1_700_000_100_000 });

    const after = JSON.parse(readFileSync(stateFile("sess-17"), "utf8"));
    // The fresher Stop write (count:0) survives — the heartbeat's stale
    // compare-and-set must have refused to overwrite it.
    assert.equal(after.count, 0);
  });

  test("the throttle stamp is claimed BEFORE the spawn runs (a spawn that reads the stamp mid-call already sees it claimed)", () => {
    connect("sess-18");
    const calls = [];
    runReport({ session_id: "sess-18", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 0 });
    let stampExistedDuringSpawn = null;
    const observingSpawn = (command, args, opts) => {
      stampExistedDuringSpawn = existsSync(heartbeatStampFile("sess-18"));
      calls.push({ command, args, opts });
      return { status: 0, stdout: JSON.stringify({ ok: true, count: 1 }), stderr: "" };
    };
    runHeartbeat({ session_id: "sess-18", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: observingSpawn, now: () => 1_000 });
    assert.equal(stampExistedDuringSpawn, true);
  });
});

// ------------------------------------------------------ dispatchMode (mode routing)

describe("dispatchMode — routes a hook's mode string to the right handler (review finding 8)", () => {
  test("stop / subagent-stop send the count", () => {
    connect("sess-19");
    for (const mode of ["stop", "subagent-stop"]) {
      const calls = [];
      dispatchMode(mode, { session_id: "sess-19", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
      assert.deepEqual(calls[0].args.slice(-1), ["1"], `mode ${mode} should report a count`);
    }
  });

  test("session-start / stop-failure send clear", () => {
    connect("sess-20");
    for (const mode of ["session-start", "stop-failure"]) {
      const calls = [];
      dispatchMode(mode, { session_id: "sess-20" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
      assert.deepEqual(calls[0].args.slice(-1), ["clear"], `mode ${mode} should clear`);
    }
  });

  test("heartbeat routes to runHeartbeat (no-op without a stored count, ticks with one)", () => {
    connect("sess-21");
    const primeCalls = [];
    dispatchMode("stop", { session_id: "sess-21", background_tasks: [{ type: "shell", status: "running" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(primeCalls), now: () => 0 });

    const calls = [];
    dispatchMode("heartbeat", { session_id: "sess-21", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-1), ["1"]);
  });

  test("an unknown mode does nothing and does not throw", () => {
    assert.doesNotThrow(() => dispatchMode("bogus-mode", { session_id: "sess-22" }, { env: env() }));
  });
});

// ----------------------------------------------------- hooks.json wiring (review finding 8)

/** Every `background-work-report.mjs <mode>` command wired into a given hook event, with whether that command entry is `async`. */
function backgroundWorkHooksFor(event) {
  const groups = HOOKS_JSON.hooks[event] ?? [];
  const found = [];
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      const match = /background-work-report\.mjs"\s+([a-z-]+)/.exec(hook.command ?? "");
      if (match) found.push({ mode: match[1], async: hook.async === true, command: hook.command });
    }
  }
  return found;
}

describe("hooks.json wiring — background-work-report.mjs is invoked with the exact mode string each event promises", () => {
  test("SessionStart runs mode session-start, and is async (review finding 2 — never block a session on a cold npx install)", () => {
    const hooks = backgroundWorkHooksFor("SessionStart");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "session-start");
    assert.equal(hooks[0].async, true);
  });

  test("Stop runs mode stop, and is async", () => {
    const hooks = backgroundWorkHooksFor("Stop");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "stop");
    assert.equal(hooks[0].async, true);
  });

  test("SubagentStop runs mode subagent-stop, and is async", () => {
    const hooks = backgroundWorkHooksFor("SubagentStop");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "subagent-stop");
    assert.equal(hooks[0].async, true);
  });

  test("StopFailure runs mode stop-failure, and is async (review finding 2)", () => {
    const hooks = backgroundWorkHooksFor("StopFailure");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "stop-failure");
    assert.equal(hooks[0].async, true);
  });

  test("PostToolUse(.*) runs mode heartbeat, and is async", () => {
    const hooks = backgroundWorkHooksFor("PostToolUse");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "heartbeat");
    assert.equal(hooks[0].async, true);
  });
});

// ---------------------------------------------------------- CLI robustness (no spawn reached)

function runCli(mode, payload) {
  return spawnSync(process.execPath, [SCRIPT, mode], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, DANXBOT_PLAN_SESSIONS_HOME: planHome },
  });
}

describe("CLI robustness — malformed input never reaches a spawn, never throws", () => {
  test("malformed JSON on stdin never exits non-zero, for every mode", () => {
    for (const mode of ["stop", "subagent-stop", "session-start", "stop-failure", "heartbeat"]) {
      const r = runCli(mode, "{not valid json");
      assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    }
  });

  test("empty stdin never exits non-zero, for every mode", () => {
    for (const mode of ["stop", "subagent-stop", "session-start", "stop-failure", "heartbeat"]) {
      const r = runCli(mode, "");
      assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
    }
  });

  test("unknown mode is silent, not an error, and does nothing", () => {
    const r = runCli("bogus-mode", { session_id: "sess-x" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(path.join(pluginData, "background-work")), false);
  });

  test("invalid session id via the real CLI never throws (stop mode)", () => {
    const r = runCli("stop", { session_id: "not valid!!", background_tasks: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(path.join(pluginData, "background-work")), false);
  });
});
