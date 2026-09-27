// danxbot background-work report hook — Stop/SubagentStop/SessionStart/
// StopFailure/PostToolUse(.*) heartbeat. DX-3367. Run with `npm test`
// (node --test).
//
// Functional behavior (stop/subagent-stop/session-start/stop-failure/
// heartbeat) is tested by importing the mode handlers directly and injecting
// a fake `spawnFn` — mirroring plan-event-bridge.test.mjs's injected
// `spawnRun` — so no test ever shells out to a real `npx` (network, slow,
// non-deterministic). Only the input-robustness cases that never reach a
// spawn at all (malformed/empty stdin, an unknown mode) are exercised as a
// real subprocess, to also prove the CLI's argv/stdin wiring.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_MCP_PACKAGE,
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
} from "../scripts/background-work-report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "background-work-report.mjs");

let pluginData;
beforeEach(() => {
  pluginData = mkdtempSync(path.join(tmpdir(), "background-work-report-test-"));
});
afterEach(() => {
  rmSync(pluginData, { recursive: true, force: true });
});

function stateFile(sessionId) {
  return path.join(pluginData, "background-work", `${sessionId}.json`);
}

function heartbeatStampFile(sessionId) {
  return path.join(pluginData, "background-work", `${sessionId}.heartbeat.json`);
}

/** A `spawnFn` stand-in that never touches a real process — records every call. */
function fakeSpawn(calls) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    return { status: 0, stdout: "", stderr: "" };
  };
}

const env = () => ({ CLAUDE_PLUGIN_DATA: pluginData });

// --------------------------------------------------------------- pure logic

describe("isValidSessionId", () => {
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
  test("counts only shell/subagent/workflow, excluding monitor/teammate/cloud session/MCP task", () => {
    const tasks = [
      { type: "shell" },
      { type: "subagent" },
      { type: "workflow" },
      { type: "monitor" },
      { type: "teammate" },
      { type: "cloud session" },
      { type: "MCP task" },
    ];
    assert.equal(countFromSnapshot(tasks), 3);
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

describe("childEnv", () => {
  test("sets CLAUDE_CODE_SESSION_ID onto a copy of the given env", () => {
    const base = { FOO: "bar" };
    const out = childEnv(base, "sess-1");
    assert.equal(out.CLAUDE_CODE_SESSION_ID, "sess-1");
    assert.equal(out.FOO, "bar");
    assert.equal(base.CLAUDE_CODE_SESSION_ID, undefined); // original untouched
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

// ------------------------------------------------------------- runReport (stop / subagent-stop)

describe("runReport — stop / subagent-stop", () => {
  test("known task types report a numeric count and persist {count, reportedAt}", () => {
    const calls = [];
    runReport(
      { session_id: "sess-1", background_tasks: [{ type: "shell" }, { type: "monitor" }, { type: "subagent" }] },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_000_000 },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["-y", DASHBOARD_MCP_PACKAGE, "background-work", "2"]);
    assert.equal(calls[0].opts.env.CLAUDE_CODE_SESSION_ID, "sess-1");

    const state = JSON.parse(readFileSync(stateFile("sess-1"), "utf8"));
    assert.equal(state.count, 2);
    assert.equal(state.reportedAt, new Date(1_700_000_000_000).toISOString());
  });

  test("missing background_tasks field reports+persists count:null as literal 'clear' (unknown, never guessed 0)", () => {
    const calls = [];
    runReport({ session_id: "sess-2" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.deepEqual(calls[0].args.slice(-1), ["clear"]);
    const state = JSON.parse(readFileSync(stateFile("sess-2"), "utf8"));
    assert.equal(state.count, null);
  });

  test("empty background_tasks array reports+persists a trusted count:0", () => {
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

  test("a spawn failure (e.g. npx missing) never throws out of runReport", () => {
    assert.doesNotThrow(() => {
      runReport(
        { session_id: "sess-4", background_tasks: [{ type: "shell" }] },
        {
          env: env(),
          spawnFn: () => {
            throw new Error("boom");
          },
        },
      );
    });
    // Local debug trail is still written even when the report itself failed.
    const state = JSON.parse(readFileSync(stateFile("sess-4"), "utf8"));
    assert.equal(state.count, 1);
  });
});

// -------------------------------------------------------- runClear (session-start / stop-failure)

describe("runClear — session-start / stop-failure", () => {
  test("always reports 'clear'", () => {
    const calls = [];
    runClear({ session_id: "sess-5" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.deepEqual(calls[0].args.slice(-1), ["clear"]);
  });

  test("removes an existing state file", () => {
    const calls = [];
    runReport({ session_id: "sess-6", background_tasks: [{ type: "shell" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(existsSync(stateFile("sess-6")), true);

    runClear({ session_id: "sess-6" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(existsSync(stateFile("sess-6")), false);
  });

  test("no prior state file is fine (force-remove) and never throws", () => {
    assert.doesNotThrow(() => runClear({ session_id: "sess-7" }, { env: env(), platform: "linux", spawnFn: fakeSpawn([]) }));
    assert.equal(existsSync(stateFile("sess-7")), false);
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
    const calls = [];
    runReport({ session_id: "sess-8", background_tasks: [{ type: "shell" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    const before = readFileSync(stateFile("sess-8"), "utf8");

    runHeartbeat({ session_id: "sess-8" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_100_000 });
    assert.equal(calls.length, 1); // only the original runReport call
    assert.equal(existsSync(heartbeatStampFile("sess-8")), false);
    assert.equal(readFileSync(stateFile("sess-8"), "utf8"), before);
  });

  test("no-op when nothing was ever stored (agent_id present, no state file)", () => {
    const calls = [];
    runHeartbeat({ session_id: "sess-9", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(heartbeatStampFile("sess-9")), false);
  });

  test("no-op when last-cleared (state removed by session-start), even with agent_id present", () => {
    const calls = [];
    runReport({ session_id: "sess-10", background_tasks: [{ type: "shell" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    runClear({ session_id: "sess-10" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    calls.length = 0;

    runHeartbeat({ session_id: "sess-10", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) });
    assert.equal(calls.length, 0);
    assert.equal(existsSync(heartbeatStampFile("sess-10")), false);
  });

  test("re-reports the stored count when due (no prior throttle stamp) and refreshes reportedAt", () => {
    const calls = [];
    runReport(
      { session_id: "sess-11", background_tasks: [{ type: "shell" }, { type: "shell" }] },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_000_000 },
    );
    const before = JSON.parse(readFileSync(stateFile("sess-11"), "utf8"));
    assert.equal(before.count, 2);
    calls.length = 0;

    runHeartbeat({ session_id: "sess-11", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_700_000_100_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-1), ["2"]); // same count, re-reported — never invented
    assert.equal(existsSync(heartbeatStampFile("sess-11")), true);

    const after = JSON.parse(readFileSync(stateFile("sess-11"), "utf8"));
    assert.equal(after.count, 2);
    assert.notEqual(after.reportedAt, before.reportedAt);
  });

  test("no-op when the throttle window has not elapsed", () => {
    const calls = [];
    runReport({ session_id: "sess-12", background_tasks: [{ type: "shell" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 0 });
    runHeartbeat({ session_id: "sess-12", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 });
    assert.equal(calls.length, 2); // the initial report + the first (due) heartbeat tick

    // Well within HEARTBEAT_THROTTLE_MS of the first tick.
    runHeartbeat({ session_id: "sess-12", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 + HEARTBEAT_THROTTLE_MS - 1 });
    assert.equal(calls.length, 2); // unchanged — throttled
  });

  test("ticks again once the throttle stamp is aged past HEARTBEAT_THROTTLE_MS", () => {
    const calls = [];
    runReport({ session_id: "sess-13", background_tasks: [{ type: "shell" }] }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 0 });
    runHeartbeat({ session_id: "sess-13", agent_id: "agent-1" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 });
    assert.equal(calls.length, 2);

    runHeartbeat(
      { session_id: "sess-13", agent_id: "agent-1" },
      { env: env(), platform: "linux", spawnFn: fakeSpawn(calls), now: () => 1_000 + HEARTBEAT_THROTTLE_MS + 1 },
    );
    assert.equal(calls.length, 3); // ticked again
  });

  test("invalid session id is refused: no spawn, no throw", () => {
    const calls = [];
    assert.doesNotThrow(() => runHeartbeat({ session_id: "../../evil", agent_id: "x" }, { env: env(), platform: "linux", spawnFn: fakeSpawn(calls) }));
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------- CLI robustness (no spawn reached)

function runCli(mode, payload) {
  return spawnSync(process.execPath, [SCRIPT, mode], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
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
