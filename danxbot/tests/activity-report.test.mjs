// danxbot activity-report hook — SubagentStart / SubagentStop / PostToolUse(Bash). DX-3284.
// Run with `npm test` (node --test).
//
// The mode logic is tested by importing `runActivity` and injecting fakes for the install check
// and the spawn, so nothing here reaches the network. The wiring from a real process — stdin, the
// install check, the installed package run with node — is tested end to end against a fake
// installed package (fixtures/fake-dashboard-mcp.mjs's `installedBinPath`) that records what it
// was run with, so the script's own argv/stdin/env contract is what is asserted, not a copy of it.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_SUBCOMMAND,
  MODE_EVENTS,
  isBackgroundBash,
  parseOutcome,
  runActivity,
  failureFile,
  stateDir,
} from "../scripts/activity-report.mjs";
import { installedBinPath } from "./fixtures/fake-dashboard-mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "activity-report.mjs");
const HOOKS_JSON = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));

const SESSION = "eae1b219-a47a-471b-9081-563a31c5476f";
const EVENT_AT_MS = Date.parse("2026-10-01T02:00:00.000Z");

let pluginData;
let planHome;
beforeEach(() => {
  pluginData = mkdtempSync(path.join(tmpdir(), "activity-report-test-"));
  planHome = mkdtempSync(path.join(tmpdir(), "activity-report-planhome-"));
});
afterEach(() => {
  rmSync(pluginData, { recursive: true, force: true });
  rmSync(planHome, { recursive: true, force: true });
});

/** The same connection record `plan_connect` writes, so the session reads as connected. */
function connect(sessionId = SESSION) {
  const dir = path.join(planHome, ".config", "danxbot", "plan-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1 }));
}

const env = () => ({
  CLAUDE_PLUGIN_DATA: pluginData,
  DANXBOT_PLAN_SESSIONS_HOME: planHome,
  CLAUDE_CODE_MESSAGING_TOKEN: "inbox-secret",
  CLAUDE_CODE_MESSAGING_SOCKET: "inbox-socket",
});

const startPayload = JSON.stringify({ session_id: SESSION, hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
const stopPayload = JSON.stringify({ session_id: SESSION, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "Explore" });
const bashPayload = JSON.stringify({
  session_id: SESSION,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  tool_input: { command: "sleep 9", description: "wait", run_in_background: true },
});
const foregroundBashPayload = JSON.stringify({
  session_id: SESSION,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: "toolu_2",
  tool_input: { command: "ls", run_in_background: false },
});

/** Fakes for the install check and the spawn, recording every call. */
function fakes({ outcome = { ok: true, runningActivities: 1 }, ensure = { ok: true, bin: "/installed/dist/index.js" }, spawnResult } = {}) {
  const calls = { ensure: 0, spawn: [], connected: [] };
  return {
    calls,
    ensureFn: () => {
      calls.ensure += 1;
      return ensure;
    },
    spawnFn: (command, args, opts) => {
      calls.spawn.push({ command, args, opts });
      return spawnResult ?? { status: 0, stdout: `${JSON.stringify(outcome)}\n`, stderr: "" };
    },
    isConnected: (sessionId, home) => {
      calls.connected.push({ sessionId, home });
      return true;
    },
  };
}

// --------------------------------------------------------------------------- pure logic

describe("isBackgroundBash", () => {
  test("only a Bash call started with run_in_background: true", () => {
    assert.equal(isBackgroundBash(JSON.parse(bashPayload)), true);
    assert.equal(isBackgroundBash(JSON.parse(foregroundBashPayload)), false);
    assert.equal(isBackgroundBash({ tool_name: "Read", tool_input: { run_in_background: true } }), false);
    assert.equal(isBackgroundBash({ tool_name: "Bash", tool_input: { command: "ls" } }), false);
    assert.equal(isBackgroundBash({ tool_name: "Bash" }), false);
    assert.equal(isBackgroundBash(null), false);
  });
});

describe("parseOutcome — the subcommand's one JSON line, never read as success unless it says so", () => {
  test("a well-formed outcome passes through, ok or not", () => {
    assert.deepEqual(parseOutcome({ stdout: '{"ok":true,"runningActivities":2}\n' }), { ok: true, runningActivities: 2 });
    assert.deepEqual(parseOutcome({ stdout: '{"ok":false,"reason":"unauthorized"}' }), { ok: false, reason: "unauthorized" });
  });
  test("no result, a spawn error, empty or unparseable output are failures", () => {
    assert.deepEqual(parseOutcome(undefined), { ok: false, reason: "no_result" });
    assert.match(parseOutcome({ error: new Error("ENOENT") }).reason, /^spawn_error: ENOENT/);
    assert.deepEqual(parseOutcome({ stdout: "" }), { ok: false, reason: "no_output" });
    assert.deepEqual(parseOutcome({ stdout: "not json" }), { ok: false, reason: "unparseable_output" });
    assert.deepEqual(parseOutcome({ stdout: '{"nope":1}' }), { ok: false, reason: "unparseable_output" });
  });
});

// --------------------------------------------------------------------------- runActivity

describe("runActivity — what it runs", () => {
  test("each mode runs the installed package with node: activity <the hook's event name> <event-at>, the payload on stdin", () => {
    for (const [mode, event, payload] of [
      ["subagent-start", "SubagentStart", startPayload],
      ["subagent-stop", "SubagentStop", stopPayload],
      ["background-bash", "PostToolUse", bashPayload],
    ]) {
      connect();
      const f = fakes();
      const outcome = runActivity(mode, payload, { env: env(), now: () => EVENT_AT_MS, ...f });
      assert.deepEqual(outcome, { ok: true, runningActivities: 1 });
      assert.equal(f.calls.spawn.length, 1);
      const { command, args, opts } = f.calls.spawn[0];
      assert.equal(command, process.execPath, "plain node, never npx");
      assert.deepEqual(args, ["/installed/dist/index.js", ACTIVITY_SUBCOMMAND, event, "2026-10-01T02:00:00.000Z"]);
      assert.equal(opts.input, payload, "the hook's own envelope, verbatim");
      assert.equal(opts.env.CLAUDE_CODE_SESSION_ID, SESSION);
      assert.equal(opts.env.CLAUDE_CODE_MESSAGING_TOKEN, undefined, "the inbox token never reaches the child");
      assert.equal(opts.env.CLAUDE_CODE_MESSAGING_SOCKET, undefined);
    }
  });

  test("the modes map to the three events the hooks are registered under", () => {
    assert.deepEqual(MODE_EVENTS, { "subagent-start": "SubagentStart", "subagent-stop": "SubagentStop", "background-bash": "PostToolUse" });
  });

  test("the event time is captured BEFORE the install check, which can take tens of seconds on a cold install", () => {
    connect();
    let clock = EVENT_AT_MS;
    const f = fakes();
    const slowEnsure = () => {
      clock += 45_000; // a cold install
      return { ok: true, bin: "/installed/dist/index.js" };
    };
    runActivity("subagent-start", startPayload, { env: env(), now: () => clock, ...f, ensureFn: slowEnsure });
    assert.equal(f.calls.spawn[0].args[3], "2026-10-01T02:00:00.000Z");
  });
});

describe("runActivity — when it does nothing", () => {
  test("a session not connected to a plan never installs or spawns anything", () => {
    const f = fakes();
    const outcome = runActivity("subagent-start", startPayload, { env: env(), now: () => EVENT_AT_MS, ...f, isConnected: () => false });
    assert.equal(outcome, null);
    assert.equal(f.calls.ensure, 0);
    assert.equal(f.calls.spawn.length, 0);
  });

  test("the plan-connection check reads the isolated home the env names", () => {
    const f = fakes();
    runActivity("subagent-stop", stopPayload, { env: env(), now: () => EVENT_AT_MS, ...f });
    assert.deepEqual(f.calls.connected, [{ sessionId: SESSION, home: planHome }]);
  });

  test("a foreground Bash call does nothing at all, not even a connection check (PostToolUse(Bash) fires for every one)", () => {
    const f = fakes();
    assert.equal(runActivity("background-bash", foregroundBashPayload, { env: env(), now: () => EVENT_AT_MS, ...f }), null);
    assert.equal(f.calls.connected.length, 0);
    assert.equal(f.calls.ensure, 0);
    assert.equal(f.calls.spawn.length, 0);
  });

  test("malformed or empty stdin, an invalid session id and an unknown mode do nothing", () => {
    const f = fakes();
    connect();
    assert.equal(runActivity("subagent-start", "{not json", { env: env(), ...f }), null);
    assert.equal(runActivity("subagent-start", "", { env: env(), ...f }), null);
    assert.equal(runActivity("subagent-start", JSON.stringify({ session_id: "../../etc" }), { env: env(), ...f }), null);
    assert.equal(runActivity("subagent-start", JSON.stringify({}), { env: env(), ...f }), null);
    assert.equal(runActivity("bogus-mode", startPayload, { env: env(), ...f }), null);
    assert.equal(f.calls.spawn.length, 0);
  });
});

describe("runActivity — failures leave a trace, successes and the ordinary 'not on a plan' answers do not", () => {
  const trace = () => {
    const file = failureFile(stateDir(env()), SESSION);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };

  test("a success writes nothing", () => {
    connect();
    runActivity("subagent-start", startPayload, { env: env(), now: () => EVENT_AT_MS, ...fakes() });
    assert.equal(trace(), null);
  });

  test("a refused or failed report records its reason, mode and time", () => {
    connect();
    const f = fakes({ outcome: { ok: false, reason: "unauthorized" } });
    const outcome = runActivity("subagent-stop", stopPayload, { env: env(), now: () => EVENT_AT_MS, ...f });
    assert.deepEqual(outcome, { ok: false, reason: "unauthorized" });
    assert.deepEqual(trace(), { at: "2026-10-01T02:00:00.000Z", mode: "subagent-stop", reason: "unauthorized" });
  });

  test("an install that failed is reported with the install's own reason, and nothing is spawned", () => {
    connect();
    const f = fakes({ ensure: { ok: false, reason: "ensure_failed: install_failed: npm install exited 1" } });
    runActivity("subagent-start", startPayload, { env: env(), now: () => EVENT_AT_MS, ...f });
    assert.equal(f.calls.spawn.length, 0);
    assert.equal(trace().reason, "ensure_failed: install_failed: npm install exited 1");
  });

  test("a spawn that produced no readable outcome is a failure, never a silent success", () => {
    connect();
    runActivity("subagent-start", startPayload, { env: env(), now: () => EVENT_AT_MS, ...fakes({ spawnResult: { status: 1, stdout: "", stderr: "" } }) });
    assert.equal(trace().reason, "no_output");
  });

  test("stale traces are pruned (the bridge's own pruning), fresh ones and other files are kept; no tmp file is left behind", () => {
    connect();
    const dir = stateDir(env());
    const old = path.join(dir, "11111111-1111-4111-8111-111111111111.last-failure.json");
    const oldTmp = path.join(dir, "11111111-1111-4111-8111-111111111111.last-failure.json.99.1.tmp");
    const fresh = path.join(dir, "22222222-2222-4222-8222-222222222222.last-failure.json");
    for (const f of [old, oldTmp, fresh]) writeFileSync(f, "{}");
    const eightDaysAgo = new Date(EVENT_AT_MS - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    utimesSync(oldTmp, eightDaysAgo, eightDaysAgo);
    utimesSync(fresh, new Date(EVENT_AT_MS), new Date(EVENT_AT_MS));

    runActivity("subagent-stop", stopPayload, { env: env(), now: () => EVENT_AT_MS, ...fakes({ outcome: { ok: false, reason: "unauthorized" } }) });

    assert.equal(existsSync(old), false);
    assert.equal(existsSync(oldTmp), false);
    assert.equal(existsSync(fresh), true);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
    assert.equal(trace().reason, "unauthorized");
  });

  test("a SUCCESSFUL report still prunes stale traces: pruning does not wait for the next failure", () => {
    connect();
    const dir = stateDir(env());
    const old = path.join(dir, "11111111-1111-4111-8111-111111111111.last-failure.json");
    writeFileSync(old, "{}");
    const eightDaysAgo = new Date(EVENT_AT_MS - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    runActivity("subagent-start", startPayload, { env: env(), now: () => EVENT_AT_MS, ...fakes() });
    assert.equal(existsSync(old), false);
  });

  test("not-on-a-plan answers are the expected case and leave no trace", () => {
    for (const reason of ["no_connection_record", "session_not_connected", "session_is_worker"]) {
      connect();
      runActivity("subagent-start", startPayload, { env: env(), now: () => EVENT_AT_MS, ...fakes({ outcome: { ok: false, reason } }) });
      assert.equal(trace(), null, reason);
    }
  });
});

// --------------------------------------------------------------------------- hooks.json wiring

/** Every `activity-report.mjs <mode>` command wired into an event, with its group's matcher and whether it is async / asyncRewake. */
function activityHooksFor(event) {
  const found = [];
  for (const group of HOOKS_JSON.hooks[event] ?? []) {
    for (const hook of group.hooks ?? []) {
      const match = /activity-report\.mjs"\s+([a-z-]+)/.exec(hook.command ?? "");
      if (match) found.push({ mode: match[1], matcher: group.matcher, async: hook.async === true, asyncRewake: hook.asyncRewake, command: hook.command });
    }
  }
  return found;
}

describe("hooks.json wiring — the three hooks, each with the mode its event promises", () => {
  test("SubagentStart (every sub-agent) -> subagent-start, async", () => {
    const hooks = activityHooksFor("SubagentStart");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "subagent-start");
    assert.equal(hooks[0].matcher, ".*");
    assert.equal(hooks[0].async, true);
  });

  test("SubagentStop -> subagent-stop, async", () => {
    const hooks = activityHooksFor("SubagentStop");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "subagent-stop");
    assert.equal(hooks[0].async, true);
  });

  test("PostToolUse is matched to Bash only (never every tool) -> background-bash, async", () => {
    const hooks = activityHooksFor("PostToolUse");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].mode, "background-bash");
    assert.equal(hooks[0].matcher, "Bash");
    assert.equal(hooks[0].async, true);
  });

  test("every mode a hook names is one the script handles, and none uses asyncRewake (an activity hook must never interrupt the session it measures)", () => {
    const all = Object.keys(HOOKS_JSON.hooks).flatMap(activityHooksFor);
    assert.equal(all.length, 3);
    for (const hook of all) {
      assert.ok(hook.mode in MODE_EVENTS, `${hook.mode} is not a mode of activity-report.mjs`);
      assert.equal(hook.asyncRewake, undefined);
    }
  });
});

// --------------------------------------------------------------------------- the real process

/** A fake installed `@thehammer/danx-dashboard-mcp` that records argv + stdin + env and answers like the real subcommand. */
const RECORDING_BIN = `
const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_RECORD_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin, session: process.env.CLAUDE_CODE_SESSION_ID }) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, runningActivities: 1 }) + "\\n");
`;

function installFakePackage() {
  const bin = installedBinPath(pluginData);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, RECORDING_BIN);
  const record = path.join(pluginData, "recorded.jsonl");
  return { record };
}

function runCli(mode, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, mode], {
    input: payload,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PLUGIN_DATA: pluginData,
      DANXBOT_PLAN_SESSIONS_HOME: planHome,
      ...extraEnv,
    },
  });
}

describe("the real process — stdin to the installed package, through the real install check", () => {
  test("a connected session's SubagentStop reaches the installed package with the verbatim envelope, the session id and an ISO event time", () => {
    connect();
    const { record } = installFakePackage();
    const r = runCli("subagent-stop", stopPayload, { FAKE_RECORD_FILE: record });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "a hook prints nothing");
    const calls = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv.slice(0, 2), [ACTIVITY_SUBCOMMAND, "SubagentStop"]);
    assert.match(calls[0].argv[2], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(calls[0].stdin, stopPayload);
    assert.equal(calls[0].session, SESSION);
  });

  test("a background Bash call is reported; a foreground one never starts the package", () => {
    connect();
    const { record } = installFakePackage();
    assert.equal(runCli("background-bash", foregroundBashPayload, { FAKE_RECORD_FILE: record }).status, 0);
    assert.equal(existsSync(record), false, "foreground Bash: the package was not run");
    assert.equal(runCli("background-bash", bashPayload, { FAKE_RECORD_FILE: record }).status, 0);
    const calls = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].argv[1], "PostToolUse");
  });

  test("a session that is not plan-connected never runs the package", () => {
    const { record } = installFakePackage();
    assert.equal(runCli("subagent-start", startPayload, { FAKE_RECORD_FILE: record }).status, 0);
    assert.equal(existsSync(record), false);
  });

  test("garbage on stdin and an unknown mode both exit 0, silently", () => {
    connect();
    installFakePackage();
    for (const [mode, payload] of [["subagent-start", "{not json"], ["subagent-start", ""], ["bogus-mode", startPayload]]) {
      const r = runCli(mode, payload);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
  });

  test("an install that cannot run fails the hook SILENTLY (exit 0) and leaves the failure trace", () => {
    connect();
    // No fake package installed, and `npm` made unrunnable: the install check must fail, not hang or throw.
    const r = runCli("subagent-start", startPayload, { PATH: path.join(pluginData, "no-such-bin"), DASHBOARD_MCP_INSTALL_TIMEOUT_SECS: "5" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    const trace = JSON.parse(readFileSync(failureFile(stateDir(env()), SESSION), "utf8"));
    assert.equal(trace.mode, "subagent-start");
    assert.match(trace.reason, /^ensure_failed|^ensure_spawn_error/);
  });
});
