// danxbot plan event bridge (DX-2784) — lifecycle, cursor, relay and supervision.
// Run with `npm test` (node --test, no dependencies).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as bridge from "../scripts/plan-event-bridge.mjs";
import * as state from "../scripts/lib/bridge-state.mjs";
import { parseHookPayload, toolResponseText } from "../scripts/lib/hook-input.mjs";
import * as failureText from "../scripts/lib/failure-notice.mjs";
import { spawnStandIn } from "./fixtures/spawn-standin.mjs";
import { started, NOW } from "./fixtures/bridge-records.mjs";
import { PKG_NAME, TEST_VERSION, recordVersion } from "./fixtures/fake-dashboard-mcp.mjs";
import { REGISTRY_BASE_URL_ENV } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION = "11111111-2222-4333-8444-555555555555";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peb-test-"));
}

/** The package spec the plugin records and runs (DX-4321: there is no literal in the plugin; the test records one). */
const SPEC = `${PKG_NAME}@${TEST_VERSION}`;

// A bridge runs the RECORDED danx-dashboard-mcp version, so every env built here has one recorded under
// `dataDir`; the registry URL points at a port nothing listens on, so a test that wrongly reached for the
// registry would fail instead of reaching npm.
function env(dataDir, overrides = {}) {
  recordVersion(dataDir, TEST_VERSION);
  return {
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_CODE_MESSAGING_SOCKET: "socket-path",
    CLAUDE_CODE_MESSAGING_TOKEN: "inbox-secret",
    [REGISTRY_BASE_URL_ENV]: "http://127.0.0.1:9",
    ...overrides,
  };
}

/** `start` never waits for a real bridge in these tests unless a test says so. */
const noVerdict = async () => null;

function pathsFor(dataDir) {
  return state.sessionPaths(state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir }), SESSION);
}

function writePid(dataDir, record) {
  fs.writeFileSync(pathsFor(dataDir).pid, JSON.stringify(record));
}

const noSleep = async () => {};

// ---------------------------------------------------------- 0. relay marker (DX-3051)

describe("RELAY_MARKER", () => {
  // Operator 2026-09-27: one short tag per message; handling rules live in plan-workflow.
  test("is one short tag, and is the whole relay prefix", () => {
    assert.equal(failureText.RELAY_MARKER, "[danxbot plan event]");
    assert.equal(bridge.RELAY_PREFIX, failureText.RELAY_MARKER);
  });

  test("relayContent is the tag, a space, then the event text, nothing else", () => {
    assert.equal(bridge.relayContent("dan commented: hi"), "[danxbot plan event] dan commented: hi");
  });

  test("a failure notice starts with the tag and says the bridge is down", () => {
    const notice = failureText.failureNotice("the bridge could not start (missing CLAUDE_PLUGIN_DATA)", "reinstall the plugin");
    assert.ok(notice.startsWith(failureText.FAILURE_PREFIX));
    assert.ok(failureText.FAILURE_PREFIX.startsWith(failureText.RELAY_MARKER));
    assert.match(notice, /bridge down: events are NOT reaching this session: .*. Fix: reinstall the plugin.$/);
  });
});

// ------------------------------------------------------------- 1. single instance

describe("single-instance lock", () => {
  test("the lock is exclusive until released", () => {
    const lock = pathsFor(tmpDir()).lock;
    assert.equal(bridge.acquireLock(lock), true);
    assert.equal(bridge.acquireLock(lock), false);
    fs.rmSync(lock);
    assert.equal(bridge.acquireLock(lock), true);
  });

  test("a start sees the lock held and does nothing", async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(pathsFor(dataDir).lock, "");
    let spawned = 0;
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      spawnRun: () => ({ pid: ++spawned }),
      stderr: () => {},
      waitVerdict: noVerdict,
    });
    assert.deepEqual(result, { started: false, reason: "another start holds the lock", exitCode: 0 });
    assert.equal(spawned, 0);
  });

  test("concurrent starts in separate processes spawn exactly one bridge", async () => {
    const dataDir = tmpDir();
    const spawnLog = path.join(dataDir, "spawns.txt");
    fs.writeFileSync(spawnLog, "");
    const contenders = Array.from({ length: 6 }, () =>
      spawn(process.execPath, [path.join(here, "fixtures", "start-race.mjs")], {
        env: {
          ...process.env,
          ...env(dataDir),
          RACE_SESSION: SESSION,
          RACE_FAKE_PID: String(process.pid),
          RACE_SPAWN_LOG: spawnLog,
          RACE_HOLD_MS: "700",
        },
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    const results = await Promise.all(
      contenders.map(async (child) => {
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        await once(child, "close");
        return JSON.parse(out);
      }),
    );
    const spawns = fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(spawns.length, 1, `expected one spawn, got ${spawns.length}: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r.started).length, 1);
    assert.equal(fs.existsSync(pathsFor(dataDir).lock), false, "the lock is released");
  });

  test("a lock left by a crashed start is taken over once it is stale", () => {
    const lock = pathsFor(tmpDir()).lock;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - bridge.LOCK_STALE_MS - 5_000);
    fs.utimesSync(lock, old, old);
    assert.equal(bridge.acquireLock(lock), true);
  });

  // DX-3028 (AC2/AC3) — `start()` mints an instanceId and MUST carry it into
  // the run process's own env as DANX_BRIDGE_INSTANCE_ID (this is how the run
  // process's heartbeats/stop records get the identity DX-2953's watchdog
  // later compares against `lastStartedInstance`). Every pre-existing test's
  // `spawnRun` double discards its `env` argument entirely — this is the
  // first test that actually captures and asserts on it.
  test("carries a minted instanceId into the run process's own env as DANX_BRIDGE_INSTANCE_ID, and it matches the pid record", async () => {
    const dataDir = tmpDir();
    let capturedEnv = null;
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      spawnRun: (sessionId, spawnEnv) => {
        capturedEnv = spawnEnv;
        return { pid: 4242 };
      },
      stderr: () => {},
      waitVerdict: noVerdict,
    });
    assert.equal(result.started, true);
    assert.equal(typeof capturedEnv.DANX_BRIDGE_INSTANCE_ID, "string");
    assert.ok(capturedEnv.DANX_BRIDGE_INSTANCE_ID.length > 0);
    // The base env's own keys still ride along unchanged (this is `{...env,
    // DANX_BRIDGE_INSTANCE_ID}`, never a replacement object).
    assert.equal(capturedEnv.CLAUDE_PLUGIN_DATA, dataDir);
    const pidRecord = state.readJsonFile(pathsFor(dataDir).pid);
    assert.equal(pidRecord.instanceId, capturedEnv.DANX_BRIDGE_INSTANCE_ID);
  });

  // DX-2954 (danxbot) — the hook input's `transcript_path` reaches the bridge
  // subcommand as DANX_BRIDGE_TRANSCRIPT_PATH, so it can collect the session's
  // stats. `run()` hands its own env to the subcommand (`childEnv`), so the run
  // process's env is where it must be set.
  test("carries the hook's transcript_path into the run process's env as DANX_BRIDGE_TRANSCRIPT_PATH", async () => {
    const dataDir = tmpDir();
    let capturedEnv = null;
    const transcriptPath = path.join(dataDir, "projects", "C--x", `${SESSION}.jsonl`);
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      transcriptPath,
      spawnRun: (sessionId, spawnEnv) => {
        capturedEnv = spawnEnv;
        return { pid: 4343 };
      },
      stderr: () => {},
      waitVerdict: noVerdict,
    });
    assert.equal(result.started, true);
    assert.equal(capturedEnv.DANX_BRIDGE_TRANSCRIPT_PATH, transcriptPath);
    // ...and on to the subcommand, which is spawned with `childEnv(runEnv)`.
    assert.equal(bridge.childEnv(capturedEnv, SESSION).DANX_BRIDGE_TRANSCRIPT_PATH, transcriptPath);
  });

  test("with no transcript_path (a hand run) it sets none, and never passes on one inherited from its own env", async () => {
    const dataDir = tmpDir();
    let capturedEnv = null;
    const result = await bridge.start({
      env: { ...env(dataDir), DANX_BRIDGE_TRANSCRIPT_PATH: "/stale/other-session.jsonl" },
      sessionId: SESSION,
      spawnRun: (sessionId, spawnEnv) => {
        capturedEnv = spawnEnv;
        return { pid: 4444 };
      },
      stderr: () => {},
      waitVerdict: noVerdict,
    });
    assert.equal(result.started, true);
    assert.equal("DANX_BRIDGE_TRANSCRIPT_PATH" in capturedEnv, false);
  });

  test("mints a DIFFERENT instanceId for each successive start (never reused across spawns)", async () => {
    const dataDir = tmpDir();
    const seen = [];
    for (let i = 0; i < 2; i += 1) {
      // Free the session for a fresh start each time.
      fs.rmSync(pathsFor(dataDir).pid, { force: true });
      const result = await bridge.start({
        env: env(dataDir),
        sessionId: SESSION,
        spawnRun: (sessionId, spawnEnv) => {
          seen.push(spawnEnv.DANX_BRIDGE_INSTANCE_ID);
          return { pid: 1000 + i };
        },
        stderr: () => {},
        waitVerdict: noVerdict,
      });
      assert.equal(result.started, true);
    }
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  });
});

// ------------------------------------------------------------- 2. stale takeover

describe("stale holder takeover", () => {
  const startWith = async (dataDir, alivePids, overrides = {}) => {
    const spawned = [];
    const killed = [];
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      isAlive: (pid) => alivePids.includes(pid),
      killTree: (pid) => killed.push(pid),
      spawnRun: () => {
        spawned.push(7777);
        return { pid: 7777 };
      },
      stderr: () => {},
      waitVerdict: noVerdict,
      ...overrides,
    });
    return { result, spawned, killed };
  };

  test("a live holder with a fresh heartbeat is left alone", async () => {
    const dataDir = tmpDir();
    writePid(dataDir, bridge.pidRecord(4242, SESSION));
    const { result, spawned } = await startWith(dataDir, [4242]);
    assert.deepEqual(result, { started: false, reason: "already bridged", exitCode: 0 });
    assert.deepEqual(spawned, []);
  });

  test("a plan_connect REPLACES a live holder, so the new plan's boards are checked", async () => {
    const dataDir = tmpDir();
    writePid(dataDir, bridge.pidRecord(4242, SESSION));
    const { result, spawned, killed } = await startWith(dataDir, [4242], { intent: bridge.CONNECT_INTENT });
    assert.equal(result.started, true);
    assert.deepEqual(spawned, [7777]);
    assert.deepEqual(killed, [4242], "the replaced bridge is ended, not left racing the new one");
    assert.equal(state.readJsonFile(pathsFor(dataDir).pid).pid, 7777);
  });

  test("a dead holder is taken over, even with a fresh heartbeat", async () => {
    const dataDir = tmpDir();
    writePid(dataDir, bridge.pidRecord(4242, SESSION));
    const { result, spawned, killed } = await startWith(dataDir, []);
    assert.deepEqual(result, { started: true, pid: 7777, verdict: "pending", exitCode: 0 });
    assert.deepEqual(spawned, [7777]);
    assert.deepEqual(killed, [], "a pid that may already belong to something else is never signalled");
    assert.equal(state.readJsonFile(pathsFor(dataDir).pid).pid, 7777);
  });

  test("a live holder whose heartbeat is stale is taken over", async () => {
    const dataDir = tmpDir();
    writePid(dataDir, bridge.pidRecord(4242, SESSION, Date.now() - state.HEARTBEAT_STALE_MS - 1_000));
    const { result, spawned } = await startWith(dataDir, [4242]);
    assert.deepEqual(result, { started: true, pid: 7777, verdict: "pending", exitCode: 0 });
    assert.deepEqual(spawned, [7777]);
    assert.equal(state.readJsonFile(pathsFor(dataDir).pid).pid, 7777);
  });

  test("isFreshHolder needs both a live pid and a recent heartbeat", () => {
    const now = Date.now();
    const alive = () => true;
    assert.equal(bridge.isFreshHolder(bridge.pidRecord(1, SESSION, now), { isAlive: alive, now }), true);
    assert.equal(bridge.isFreshHolder(bridge.pidRecord(1, SESSION, now), { isAlive: () => false, now }), false);
    assert.equal(bridge.isFreshHolder(bridge.pidRecord(1, SESSION, now - state.HEARTBEAT_STALE_MS - 1), { isAlive: alive, now }), false);
    assert.equal(bridge.isFreshHolder({ pid: 1 }, { isAlive: alive, now }), false);
    assert.equal(bridge.isFreshHolder(null, { isAlive: alive, now }), false);
  });

  test("stop signals a live heartbeating holder, never a stale pid, and always removes the pid file", () => {
    const dataDir = tmpDir();
    const killed = [];
    writePid(dataDir, bridge.pidRecord(4242, SESSION));
    bridge.stop({ env: env(dataDir), sessionId: SESSION, isAlive: () => true, killTree: (pid) => killed.push(pid) });
    assert.deepEqual(killed, [4242]);
    assert.equal(fs.existsSync(pathsFor(dataDir).pid), false);

    writePid(dataDir, bridge.pidRecord(4343, SESSION, Date.now() - state.HEARTBEAT_STALE_MS - 1_000));
    bridge.stop({ env: env(dataDir), sessionId: SESSION, isAlive: () => true, killTree: (pid) => killed.push(pid) });
    assert.deepEqual(killed, [4242]);
    assert.equal(fs.existsSync(pathsFor(dataDir).pid), false);
  });
});

// ----------------------------------------------------------------- 3. run yields

describe("heartbeat", () => {
  test("yields when the pid file names another bridge, and does not overwrite it", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    writePid(dataDir, bridge.pidRecord(9999, SESSION));
    const reasons = [];
    const ok = bridge.heartbeatTick({ paths, selfPid: 1234, sessionId: SESSION, shutdown: (why) => reasons.push(why) });
    assert.equal(ok, false);
    assert.deepEqual(reasons, ["another bridge owns this session"]);
    assert.equal(state.readJsonFile(paths.pid).pid, 9999);
  });

  test("refreshes its own record atomically when the pid file names itself", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    writePid(dataDir, bridge.pidRecord(1234, SESSION, 0));
    const reasons = [];
    const now = Date.parse("2026-09-15T05:00:00.000Z");
    assert.equal(bridge.heartbeatTick({ paths, selfPid: 1234, sessionId: SESSION, now, shutdown: (why) => reasons.push(why) }), true);
    assert.deepEqual(reasons, []);
    // DX-3028 — `instanceId`/`startedAt` are PRESERVED from the record
    // already on file (written by `pidRecord(1234, SESSION, 0)` above, whose
    // `now=0` gives `startedAt` the epoch), never regenerated by a heartbeat.
    assert.deepEqual(state.readJsonFile(paths.pid), {
      pid: 1234,
      sessionId: SESSION,
      heartbeatAt: "2026-09-15T05:00:00.000Z",
      instanceId: null,
      startedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.deepEqual(fs.readdirSync(path.dirname(paths.pid)).filter((n) => n.endsWith(".tmp")), []);
  });

  // DX-3028 (AC2/AC3) — `instanceId`/`startedAt` survive every heartbeat
  // unchanged; only `heartbeatAt` advances. This is what lets a stop record
  // written much later still be compared against the SAME identity the
  // process was spawned with.
  test("preserves instanceId and startedAt across every heartbeat — only heartbeatAt advances", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    writePid(dataDir, bridge.pidRecord(1234, SESSION, Date.parse("2026-09-15T04:00:00.000Z"), "instance-abc"));
    bridge.heartbeatTick({ paths, selfPid: 1234, sessionId: SESSION, now: Date.parse("2026-09-15T05:00:00.000Z"), shutdown: () => {} });
    bridge.heartbeatTick({ paths, selfPid: 1234, sessionId: SESSION, now: Date.parse("2026-09-15T05:00:30.000Z"), shutdown: () => {} });
    assert.deepEqual(state.readJsonFile(paths.pid), {
      pid: 1234,
      sessionId: SESSION,
      heartbeatAt: "2026-09-15T05:00:30.000Z",
      instanceId: "instance-abc",
      startedAt: "2026-09-15T04:00:00.000Z",
    });
  });
});

// -------------------------------------------------- 3b. persistStopRecord (DX-3028 AC3)

// Test-review finding — `persistStopRecord` (the literal function AC3 exists
// to add: "the parent persists that record to a local stop-record file") had
// ZERO test coverage: no test called it, none asserted its JSON shape, and
// the `record.instanceId || writingInstanceId` fallback was untested. This
// matters beyond this card — DX-2953 depends on this exact file shape.
describe("persistStopRecord (DX-3028 AC3)", () => {
  test("writes the full stop-record shape, atomically (no leftover .tmp file)", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    bridge.persistStopRecord(
      paths.stopped,
      { reason: "board_unreadable", detail: "d", fix: "f", paths: ["/a.json"], instanceId: "i-1", degraded: true },
      "i-1",
      Date.parse("2026-09-21T00:00:00.000Z"),
    );
    assert.deepEqual(state.readJsonFile(paths.stopped), {
      schemaVersion: 1,
      reason: "board_unreadable",
      detail: "d",
      fix: "f",
      paths: ["/a.json"],
      instanceId: "i-1",
      writingInstanceId: "i-1",
      degraded: true,
      recordedAt: "2026-09-21T00:00:00.000Z",
    });
    assert.deepEqual(fs.readdirSync(path.dirname(paths.stopped)).filter((n) => n.endsWith(".tmp")), []);
  });

  test("falls back to writingInstanceId when the child's own record carries none (e.g. a pre-DX-3028 subcommand, or a spawn-time bridge_failed)", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    bridge.persistStopRecord(
      paths.stopped,
      { reason: "bridge_failed", detail: "spawn ENOENT", fix: "", paths: [], instanceId: "", degraded: false },
      "run-instance-xyz",
      0,
    );
    const record = state.readJsonFile(paths.stopped);
    assert.equal(record.instanceId, "run-instance-xyz");
    assert.equal(record.writingInstanceId, "run-instance-xyz");
  });

  test("a record that DOES carry its own instanceId keeps it, distinct from writingInstanceId if they ever differ", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    bridge.persistStopRecord(
      paths.stopped,
      { reason: "revoked", detail: "d", fix: "f", paths: [], instanceId: "child-instance", degraded: true },
      "run-instance-different",
      0,
    );
    const record = state.readJsonFile(paths.stopped);
    assert.equal(record.instanceId, "child-instance");
    assert.equal(record.writingInstanceId, "run-instance-different");
  });

  test("overwrites — only the most recent record survives", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    bridge.persistStopRecord(paths.stopped, { reason: "revoked", detail: "first", fix: "", paths: [], instanceId: "i-1", degraded: true }, "i-1", 0);
    bridge.persistStopRecord(
      paths.stopped,
      { reason: "not_connected", detail: "second", fix: "", paths: [], instanceId: "i-1", degraded: false },
      "i-1",
      1,
    );
    assert.equal(state.readJsonFile(paths.stopped).reason, "not_connected");
  });

  test("paths.stopped is a real, distinct path ending in .stopped.json, covered by pruneStale via STATE_SUFFIXES", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    assert.ok(paths.stopped.endsWith(".stopped.json"));
    bridge.persistStopRecord(paths.stopped, { reason: "revoked", detail: "d", fix: "", paths: [], instanceId: "i-1", degraded: true }, "i-1", Date.now());
    assert.equal(fs.existsSync(paths.stopped), true);
    // A file far older than STALE_STATE_MS is pruned by the existing sweep —
    // proves .stopped.json rides the same STATE_SUFFIXES list as .pid.json.
    const old = new Date(Date.now() - bridge.STALE_STATE_MS - 5_000);
    fs.utimesSync(paths.stopped, old, old);
    bridge.pruneStale(path.dirname(paths.stopped));
    assert.equal(fs.existsSync(paths.stopped), false);
  });
});

// ---------------------------------------------------- 4. terminal vs retry exits

/** A fake subcommand: writes stdout/stderr chunks, then closes with `code`. */
function fakeChild({ stdout = [], stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 5150;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(async () => {
    for (const chunk of stdout) child.stdout.write(chunk);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
    child.emit("close", code);
  });
  return child;
}

const recordLine = (record) => `${JSON.stringify(record)}\n`;

function spyRelay() {
  const pushed = [];
  return { pushed, relay: { push: (event) => pushed.push(event) } };
}

describe("subcommand exit handling", () => {
  test("any stop record is terminal, whatever the reason; only bridge_failed is fatal", () => {
    for (const reason of ["not_connected", "unauthorized", "mint_refused", "mint_bad_response", "superseded", "replaced", "revoked", "refused"]) {
      assert.deepEqual(bridge.classifyChildExit({ stopped: { reason, detail: "d" }, code: 1, ranMs: 10 * 60_000 }), {
        action: "exit",
        reason: `${reason}: d`,
        fatal: false,
        stopReason: reason,
        fix: "",
      });
    }
    assert.deepEqual(bridge.classifyChildExit({ stopped: { reason: "bridge_failed", detail: "spawn ENOENT" }, code: null, ranMs: 10 }), {
      action: "exit",
      reason: "bridge_failed: spawn ENOENT",
      fatal: true,
      stopReason: "bridge_failed",
      fix: "",
    });
  });

  test("a death with no stop record at all still carries a remedy, since the subcommand supplied none", () => {
    const decision = bridge.classifyChildExit({ stopped: null, code: 1, ranMs: 10 });
    assert.equal(decision.stopReason, "bridge_failed");
    assert.match(decision.fix, /log/);
  });

  test("the subcommand's own remedy travels with its stop, so the session is told what to do", () => {
    const decision = bridge.classifyChildExit({
      stopped: { reason: "board_unreadable", detail: "cannot read board x:y", fix: "scope the credential to read x:y" },
      code: 1,
      ranMs: 10,
    });
    assert.equal(decision.stopReason, "board_unreadable");
    assert.equal(decision.fix, "scope the credential to read x:y");
  });

  test("a quick death without a stop record is terminal and fatal; one after a healthy run is restarted", () => {
    assert.equal(bridge.classifyChildExit({ stopped: null, code: 1, ranMs: 500 }).action, "exit");
    assert.match(bridge.classifyChildExit({ stopped: null, code: 1, ranMs: 500 }).reason, /^bridge_failed/);
    assert.equal(bridge.classifyChildExit({ stopped: null, code: 1, ranMs: 500 }).fatal, true);
    assert.equal(bridge.classifyChildExit({ stopped: null, code: null, ranMs: state.HEALTHY_RUN_MS }).action, "restart");
  });

  test("supervision restarts after a healthy crash and exits on the next stop record", async () => {
    let clock = 0;
    const spawns = [];
    const logs = [];
    const { relay } = spyRelay();
    const { reason, fatal } = await bridge.superviseBridge({
      spawnChild: () => {
        spawns.push(clock);
        if (spawns.length === 1) {
          clock += state.HEALTHY_RUN_MS + 1_000;
          return fakeChild({ code: null });
        }
        return fakeChild({ stdout: [recordLine({ type: "stopped", reason: "not_connected", detail: "the session is not connected to a plan" })], code: 1 });
      },
      relay,
      log: (m) => logs.push(m),
      now: () => clock,
      sleep: noSleep,
    });
    assert.equal(reason, "not_connected: the session is not connected to a plan");
    assert.equal(fatal, false);
    assert.equal(spawns.length, 2);
    assert.ok(logs.some((m) => m.startsWith("restarting the bridge subcommand")));
  });

  test("an npx E404 is a terminal reason with its stderr tail logged, never a retry loop", async () => {
    const logs = [];
    let spawns = 0;
    const { relay } = spyRelay();
    const { reason, fatal, stopReason } = await bridge.superviseBridge({
      spawnChild: () => {
        spawns += 1;
        return fakeChild({ stderr: `npm error code E404\nnpm error 404 Not Found\n`, code: 1 });
      },
      relay,
      log: (m) => logs.push(m),
      now: () => 0,
      sleep: noSleep,
    });
    assert.match(reason, /^bridge_failed: .*code 1/);
    assert.equal(fatal, true);
    assert.equal(stopReason, "bridge_failed");
    assert.equal(spawns, 1);
    assert.match(
      logs.find((m) => m.startsWith("bridge subcommand stderr (tail): ")),
      /E404/,
    );
  });

  test("a ready record is handed to the caller, once, before any event", async () => {
    const ready = [];
    const { pushed, relay } = spyRelay();
    await bridge.superviseBridge({
      spawnChild: () =>
        fakeChild({
          stdout: [
            recordLine({ type: "ready", boards: ["danxbot:danxbot-main", "gpt-manager:main"] }),
            recordLine({ type: "event", id: 1, text: "one" }),
            recordLine({ type: "stopped", reason: "superseded", detail: "d" }),
          ],
        }),
      relay,
      log: () => {},
      now: () => 0,
      sleep: noSleep,
      onReady: (record) => ready.push(record),
    });
    assert.deepEqual(ready, [
      { kind: "ready", boards: ["danxbot:danxbot-main", "gpt-manager:main"], cardCount: null, degraded: false, inventoryError: null },
    ]);
    assert.deepEqual(pushed, [{ id: 1, text: "one" }]);
  });

  test("a stderr tail is capped", async () => {
    const logs = [];
    await bridge.superviseBridge({
      spawnChild: () => fakeChild({ stderr: "x".repeat(bridge.STDERR_TAIL_CHARS * 3), code: 1 }),
      relay: spyRelay().relay,
      log: (m) => logs.push(m),
      now: () => 0,
      sleep: noSleep,
    });
    const tail = logs.find((m) => m.startsWith("bridge subcommand stderr (tail): "));
    assert.equal(tail.length, "bridge subcommand stderr (tail): ".length + bridge.STDERR_TAIL_CHARS);
  });

  test("a spawn that throws (npx not found) is terminal and fatal", async () => {
    const { reason, fatal } = await bridge.superviseBridge({
      spawnChild: () => {
        throw new Error("npx not found: expected X next to Y");
      },
      relay: spyRelay().relay,
      log: () => {},
      now: () => 0,
      sleep: noSleep,
    });
    assert.equal(reason, "bridge_failed: npx not found: expected X next to Y");
    assert.equal(fatal, true);
  });

  // Test-review finding (DX-3028 AC2/AC3) — `onStopped`/degraded-record
  // non-terminal behavior was entirely unexercised: no `superviseBridge` test
  // passed an `onStopped` callback, and no fixture emitted a degraded stop
  // record followed by more output. This is the core of `runChildOnce`'s
  // change: a `degraded:true` record must NOT end the promise (the child
  // stays alive), only a non-degraded one does.
  test("a degraded stop record reaches onStopped but does NOT end supervision — events after it still relay, and the run's own outcome reflects the LATER, non-degraded record", async () => {
    const stopped = [];
    const { pushed, relay } = spyRelay();
    const { reason, fatal } = await bridge.superviseBridge({
      spawnChild: () =>
        fakeChild({
          stdout: [
            recordLine({
              type: "stopped",
              reason: "board_unreadable",
              detail: "d1",
              fix: "f1",
              paths: ["/a.json"],
              instanceId: "i-1",
              degraded: true,
            }),
            // Proves the child was NOT treated as exited when the degraded
            // record arrived — a genuinely-ended child would never relay
            // another event afterward.
            recordLine({ type: "event", id: 9, text: "still alive after degrading" }),
            recordLine({
              type: "stopped",
              reason: "not_connected",
              detail: "d2",
              fix: "f2",
              paths: [],
              instanceId: "i-1",
              degraded: false,
            }),
          ],
          code: 1,
        }),
      relay,
      log: () => {},
      now: () => 0,
      sleep: noSleep,
      onStopped: (record) => stopped.push(record),
    });
    assert.deepEqual(
      stopped.map((r) => [r.reason, r.degraded]),
      [
        ["board_unreadable", true],
        ["not_connected", false],
      ],
    );
    assert.deepEqual(pushed, [{ id: 9, text: "still alive after degrading" }]);
    assert.equal(reason, "not_connected: d2");
    assert.equal(fatal, false);
  });

  test("a spawnChild that throws still reaches onStopped with a synthesized bridge_failed record (degraded:false)", async () => {
    const stopped = [];
    await bridge.superviseBridge({
      spawnChild: () => {
        throw new Error("npx not found");
      },
      relay: spyRelay().relay,
      log: () => {},
      now: () => 0,
      sleep: noSleep,
      onStopped: (record) => stopped.push(record),
    });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].reason, "bridge_failed");
    assert.equal(stopped[0].degraded, false);
  });

  test("onStopped is entirely optional — supervision behaves identically when it is omitted (pre-DX-3028 call shape)", async () => {
    const { relay } = spyRelay();
    const { reason, fatal } = await bridge.superviseBridge({
      spawnChild: () => fakeChild({ stdout: [recordLine({ type: "stopped", reason: "not_connected", detail: "d" })], code: 1 }),
      relay,
      log: () => {},
      now: () => 0,
      sleep: noSleep,
    });
    assert.equal(reason, "not_connected: d");
    assert.equal(fatal, false);
  });
});

// -------------------------------------------------------------------- 5. cursor

describe("cursor", () => {
  test("drops ids that are not positive integers and keeps only the newest CURSOR_ID_MEMORY", () => {
    const file = pathsFor(tmpDir()).cursor;
    const many = Array.from({ length: bridge.CURSOR_ID_MEMORY + 50 }, (_, i) => i + 1);
    fs.writeFileSync(file, JSON.stringify({ deliveredIds: [0, -1, "7", 1.5, null, ...many] }));
    const ids = bridge.readCursor(file);
    assert.equal(ids.length, bridge.CURSOR_ID_MEMORY);
    assert.equal(ids[0], 51);
    assert.equal(ids.at(-1), bridge.CURSOR_ID_MEMORY + 50);
  });

  test("an unreadable or missing cursor is empty", () => {
    const file = pathsFor(tmpDir()).cursor;
    assert.deepEqual(bridge.readCursor(file), []);
    fs.writeFileSync(file, "{torn");
    assert.deepEqual(bridge.readCursor(file), []);
  });

  test("records dedupe (a re-recorded id moves to newest) and stay capped", () => {
    const file = pathsFor(tmpDir()).cursor;
    for (let id = 1; id <= bridge.CURSOR_ID_MEMORY + 5; id += 1) bridge.recordDelivered(file, id);
    bridge.recordDelivered(file, 50);
    const ids = bridge.readCursor(file);
    assert.equal(ids.length, bridge.CURSOR_ID_MEMORY);
    assert.equal(ids.filter((id) => id === 50).length, 1);
    assert.equal(ids.at(-1), 50);
    // 1..105 keeps 6..105; re-recording 50 moves it rather than adding one, so 6 is still the oldest.
    assert.equal(ids[0], 6);
  });

  test("a record is written to a temp file and renamed into place", () => {
    const file = pathsFor(tmpDir()).cursor;
    const writes = [];
    const renames = [];
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    fs.writeFileSync = (target, ...rest) => {
      writes.push(String(target));
      return realWrite(target, ...rest);
    };
    fs.renameSync = (from, to) => {
      renames.push([String(from), String(to)]);
      return realRename(from, to);
    };
    try {
      bridge.recordDelivered(file, 3);
    } finally {
      fs.writeFileSync = realWrite;
      fs.renameSync = realRename;
    }
    assert.equal(writes.includes(file), false, "never written in place");
    assert.deepEqual(renames.map(([, to]) => to), [file]);
    assert.equal(renames[0][0], writes[0]);
    assert.deepEqual(bridge.readCursor(file), [3]);
  });

  test("--resume-ids is built from the cursor, and absent when it is empty", () => {
    const posix = { platform: "linux" };
    assert.deepEqual(bridge.bridgeCommand({ resumeIds: [], spec: SPEC, ...posix }), {
      command: "npx",
      args: ["-y", SPEC, "bridge"],
    });
    const file = pathsFor(tmpDir()).cursor;
    bridge.recordDelivered(file, 41);
    bridge.recordDelivered(file, 42);
    assert.deepEqual(bridge.bridgeCommand({ resumeIds: bridge.readCursor(file), spec: SPEC, ...posix }).args.slice(-2), ["--resume-ids", "41,42"]);
  });
});

// ---------------------------------------------------------- 6. env and command

describe("subcommand environment and command", () => {
  test("the child env carries the session id, not the inbox token or socket", () => {
    const child = bridge.childEnv(env("/data", { PATH: "/bin" }), SESSION);
    assert.equal(child.CLAUDE_CODE_SESSION_ID, SESSION);
    assert.equal(child.PATH, "/bin");
    assert.equal("CLAUDE_CODE_MESSAGING_TOKEN" in child, false);
    assert.equal("CLAUDE_CODE_MESSAGING_SOCKET" in child, false);
  });

  test("this script requires no dashboard credential of its own — DX-2862", () => {
    // DX-2862: the subcommand reads the session's own MCP server's connection record for its
    // dashboard credential — this script must never read either of these names itself.
    assert.deepEqual(bridge.REQUIRED_ENV, [
      "CLAUDE_PLUGIN_DATA",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
    ]);
    const source = fs.readFileSync(new URL("../scripts/plan-event-bridge.mjs", import.meta.url), "utf8");
    for (const banned of ["env.DANXBOT_DISPATCH_TOKEN", "env.DANXBOT_DASHBOARD_URL"]) {
      assert.equal(source.includes(banned), false, `${banned} must not be read by this script`);
    }
  });

  test("no secret ever appears in the command's arguments", () => {
    const secrets = ["dispatch-secret", "inbox-secret"];
    for (const platform of ["linux", "win32"]) {
      const { command, args } = bridge.bridgeCommand({ resumeIds: [1, 2], spec: SPEC, platform, execPath: "C:\\node\\node.exe", exists: () => true });
      const joined = [command, ...args].join(" ");
      for (const secret of secrets) assert.equal(joined.includes(secret), false);
    }
  });

  test("on Windows the subcommand runs through node and npm's JS entry, never a shell; a missing entry is an error", () => {
    const execPath = path.join("C:", "nodejs", "node.exe");
    const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
    assert.deepEqual(bridge.bridgeCommand({ resumeIds: [9], spec: SPEC, platform: "win32", execPath, exists: (p) => p === npxCli }), {
      command: execPath,
      args: [npxCli, "-y", SPEC, "bridge", "--resume-ids", "9"],
    });
    assert.throws(() => bridge.bridgeCommand({ resumeIds: [], spec: SPEC, platform: "win32", execPath, exists: () => false }), /npx not found/);
  });
});

// ---------------------------------------------------------------- 7. inbox post

test("postToInbox sends the auth frame then the user message, one JSON object per line", async () => {
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\peb-test-${process.pid}-${Date.now()}`
      : path.join(tmpDir(), "inbox.sock");
  let received = "";
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => (received += chunk));
  });
  await new Promise((resolve) => server.listen(address, resolve));
  try {
    await bridge.postToInbox("hello from the bridge", { CLAUDE_CODE_MESSAGING_SOCKET: address, CLAUDE_CODE_MESSAGING_TOKEN: "inbox-secret" });
  } finally {
    server.close();
  }
  const lines = received.split("\n");
  assert.equal(lines.at(-1), "");
  assert.deepEqual(lines.slice(0, -1).map((line) => JSON.parse(line)), [
    { type: "auth", token: "inbox-secret" },
    { type: "user", message: { role: "user", content: "hello from the bridge" } },
  ]);
});

// ------------------------------------------------------------ 8. output parsing

describe("output parsing", () => {
  test("lines are reassembled across arbitrary chunk splits and CRLF", () => {
    const lines = [];
    const feed = bridge.createLineSplitter((line) => lines.push(line));
    feed('{"type":"ev');
    feed('ent","id":1,"text":"a"}\r\n{"type":"event","id":2,');
    feed('"text":"b"}\n\n');
    feed('{"partial":');
    assert.deepEqual(lines, ['{"type":"event","id":1,"text":"a"}', '{"type":"event","id":2,"text":"b"}']);
  });

  test("records are classified; non-JSON and unknown shapes are junk", () => {
    assert.deepEqual(bridge.parseRecord('{"type":"event","id":3,"text":"t"}'), { kind: "event", id: 3, text: "t" });
    assert.deepEqual(bridge.parseRecord('{"type":"event","id":null,"text":"t"}'), { kind: "event", id: null, text: "t" });
    assert.deepEqual(bridge.parseRecord('{"type":"event","id":0,"text":"t"}'), { kind: "event", id: null, text: "t" });
    // DX-3028 (AC3) — `paths`/`instanceId`/`degraded` are new on every
    // "stopped" record; a line that carries none of them (an older,
    // pre-DX-3028 subcommand) defaults to the ONLY behavior that existed
    // before this card: empty paths, no instance id, not degraded (exit).
    assert.deepEqual(bridge.parseRecord('{"type":"stopped","reason":"revoked","detail":"d"}'), {
      kind: "stopped",
      reason: "revoked",
      detail: "d",
      fix: "",
      paths: [],
      instanceId: "",
      degraded: false,
    });
    assert.deepEqual(bridge.parseRecord('{"type":"stopped","reason":"revoked","detail":"d","fix":"do x"}'), {
      kind: "stopped",
      reason: "revoked",
      detail: "d",
      fix: "do x",
      paths: [],
      instanceId: "",
      degraded: false,
    });
    assert.deepEqual(
      bridge.parseRecord(
        '{"type":"stopped","reason":"board_unreadable","detail":"d","fix":"widen scope","paths":["/a.json"],"instanceId":"i-1","degraded":true}',
      ),
      { kind: "stopped", reason: "board_unreadable", detail: "d", fix: "widen scope", paths: ["/a.json"], instanceId: "i-1", degraded: true },
    );
    // DX-3059 — `cardCount`/`degraded` ride alongside `boards` now; `boards:
    // null` (inventory read failed) is kept distinct from `boards: []`
    // (read succeeded, no boards reachable) — see `describeReadyRecord`.
    assert.deepEqual(bridge.parseRecord('{"type":"ready","boards":["a:b"],"cardCount":3,"degraded":false}'), {
      kind: "ready",
      boards: ["a:b"],
      cardCount: 3,
      degraded: false,
      inventoryError: null,
    });
    assert.deepEqual(bridge.parseRecord('{"type":"ready","boards":["a:b"],"cardCount":0,"degraded":true}'), {
      kind: "ready",
      boards: ["a:b"],
      cardCount: 0,
      degraded: true,
      inventoryError: null,
    });
    assert.deepEqual(bridge.parseRecord('{"type":"ready","boards":[],"cardCount":0,"degraded":true}'), {
      kind: "ready",
      boards: [],
      cardCount: 0,
      degraded: true,
      inventoryError: null,
    });
    assert.deepEqual(bridge.parseRecord('{"type":"ready","boards":null,"cardCount":null,"degraded":true}'), {
      kind: "ready",
      boards: null,
      cardCount: null,
      degraded: true,
      inventoryError: null,
    });
    // DX-3928: the server's inventoryError string is kept on the ready record.
    assert.deepEqual(
      bridge.parseRecord('{"type":"ready","boards":null,"cardCount":null,"degraded":true,"inventoryError":"plan inventory: 503"}'),
      { kind: "ready", boards: null, cardCount: null, degraded: true, inventoryError: "plan inventory: 503" },
    );
    // pre-DX-2970 subcommand: no boards/cardCount/degraded on the wire at all.
    assert.deepEqual(bridge.parseRecord('{"type":"ready"}'), { kind: "ready", boards: [], cardCount: null, degraded: false, inventoryError: null });
    assert.deepEqual(bridge.parseRecord("npm warn exec something"), { kind: "junk" });
    assert.deepEqual(bridge.parseRecord('{"type":"event","id":3}'), { kind: "junk" });
  });

  test("supervision relays events in order, ignores junk, and hands an id-less event on with id null", async () => {
    const { pushed, relay } = spyRelay();
    const logs = [];
    await bridge.superviseBridge({
      spawnChild: () =>
        fakeChild({
          stdout: [
            '{"type":"event","id":1,"te',
            'xt":"one"}\nnot json\n',
            recordLine({ type: "event", id: null, text: "no id" }),
            recordLine({ type: "stopped", reason: "superseded", detail: "d" }),
          ],
        }),
      relay,
      log: (m) => logs.push(m),
      now: () => 0,
      sleep: noSleep,
    });
    assert.deepEqual(pushed, [
      { id: 1, text: "one" },
      { id: null, text: "no id" },
    ]);
    assert.ok(logs.some((m) => m.startsWith("ignored non-record output")));
  });

  test("an id-less event is relayed but never recorded", async () => {
    const posted = [];
    const recorded = [];
    const queue = bridge.createRelayQueue({
      post: async (content) => posted.push(content),
      record: (id) => recorded.push(id),
      log: () => {},
      sleep: noSleep,
    });
    queue.push({ id: null, text: "no id" });
    queue.push({ id: 8, text: "eight" });
    await queue.idle();
    assert.deepEqual(posted, [bridge.relayContent("no id"), bridge.relayContent("eight")]);
    assert.deepEqual(recorded, [8]);
  });
});

// ------------------------------------------------- 8b. degraded ready reporting (DX-3059)

describe("describeReadyRecord (DX-3059)", () => {
  test("degraded: the inventory read itself failed (boards null) reads as a problem, names what's unreachable, says what to do", () => {
    const message = bridge.describeReadyRecord({ boards: null, cardCount: null, degraded: true });
    assert.match(message, /^DEGRADED/);
    assert.match(message, /inventory read failed/);
    assert.match(message, /plan_connect/);
    assert.doesNotMatch(message, /no cards yet/);
  });

  test("DX-3928: a ready record carrying inventoryError prints the string in the DEGRADED line", () => {
    const message = bridge.describeReadyRecord({ boards: null, cardCount: null, degraded: true, inventoryError: "plan inventory: 503 upstream" });
    assert.match(message, /^DEGRADED/);
    assert.match(message, /\(plan inventory: 503 upstream\)/);
  });

  test("DX-3928: a null inventoryError prints nothing extra", () => {
    const withNull = bridge.describeReadyRecord({ boards: null, cardCount: null, degraded: true, inventoryError: null });
    const without = bridge.describeReadyRecord({ boards: null, cardCount: null, degraded: true });
    assert.equal(withNull, without);
    assert.doesNotMatch(withNull, /\(\)|null/);
  });

  test("degraded: the credential can see no board at all (boards empty, read succeeded) reads as a problem, not the benign no-cards text", () => {
    const message = bridge.describeReadyRecord({ boards: [], cardCount: 0, degraded: true });
    assert.match(message, /^DEGRADED/);
    assert.match(message, /cannot see any board/);
    assert.doesNotMatch(message, /no cards yet/);
    assert.doesNotMatch(message, /none — the connected plan has no cards/);
  });

  test("healthy but genuinely empty: real boards are known and reachable, the plan simply has zero cards — benign, not a problem", () => {
    // Server's own `degraded` flag is true here too (cardCount === 0), but
    // boards are known and non-empty, so this must NOT read as a problem —
    // AC 32626.
    const message = bridge.describeReadyRecord({
      boards: ["danxbot:danxbot-main"],
      cardCount: 0,
      degraded: true,
      inventoryError: null,
    });
    assert.doesNotMatch(message, /^DEGRADED/);
    assert.match(message, /danxbot:danxbot-main/);
    assert.match(message, /no cards yet/);
  });

  test("healthy with cards: unchanged, no problem language, no no-cards text", () => {
    const message = bridge.describeReadyRecord({
      boards: ["danxbot:danxbot-main", "gpt-manager:main"],
      cardCount: 114,
      degraded: false,
    });
    assert.doesNotMatch(message, /^DEGRADED/);
    assert.match(message, /danxbot:danxbot-main, gpt-manager:main/);
    assert.doesNotMatch(message, /no cards yet/);
  });

  test("a test asserting only the degraded path would NOT catch the empty-plan path regressing to DEGRADED", () => {
    // Regression guard for AC 32627's own requirement: prove the two paths
    // are independently distinguishable, not just that "degraded" alone
    // never appears anywhere.
    const degraded = bridge.describeReadyRecord({ boards: [], cardCount: 0, degraded: true });
    const emptyHealthy = bridge.describeReadyRecord({ boards: ["danxbot:danxbot-main"], cardCount: 0, degraded: true });
    assert.match(degraded, /^DEGRADED/);
    assert.doesNotMatch(emptyHealthy, /^DEGRADED/);
  });
});

// --------------------------------------------------------- 9. failed post

describe("delivery failures", () => {
  test("an event whose post fails is NOT recorded, holds later events, is logged loudly, and is redelivered", async () => {
    const posted = [];
    const recorded = [];
    const logs = [];
    let failuresLeft = bridge.SOCKET_POST_ATTEMPTS;
    const queue = bridge.createRelayQueue({
      post: async (content) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          assert.deepEqual(recorded, [], "nothing is recorded while the head is failing");
          throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
        }
        posted.push(content);
      },
      record: (id) => recorded.push(id),
      log: (m) => logs.push(m),
      sleep: noSleep,
    });
    queue.push({ id: 1, text: "one" });
    queue.push({ id: 2, text: "two" });
    await queue.idle();
    assert.ok(logs.some((m) => /^INBOX POST FAILED for event 1 after 3 attempts \(EPIPE\); NOT recorded — holding it and 1 later event/.test(m)));
    assert.deepEqual(posted, [bridge.relayContent("one"), bridge.relayContent("two")]);
    assert.deepEqual(recorded, [1, 2]);
  });

  test("a bridge that stops while the head keeps failing leaves the event unrecorded for the next bridge", async () => {
    const recorded = [];
    let stopped = false;
    const queue = bridge.createRelayQueue({
      post: async () => {
        throw new Error("no inbox");
      },
      record: (id) => recorded.push(id),
      log: () => {},
      sleep: async () => {
        stopped = true;
      },
      isStopped: () => stopped,
    });
    queue.push({ id: 5, text: "five" });
    await queue.idle();
    assert.deepEqual(recorded, []);
    assert.equal(queue.pending(), 1);
  });
});

// --------------------------------------------------------- 9b. queue overflow

describe("relay queue overflow", () => {
  test("the queue never grows past its cap; overflow fires onOverflow once, logs loudly, and nothing is recorded", async () => {
    const recorded = [];
    const logs = [];
    let overflowed = false;
    let overflowCalls = 0;
    let overflowReason = null;
    const queue = bridge.createRelayQueue({
      post: async () => {
        throw Object.assign(new Error("no inbox"), { code: "ECONNREFUSED" });
      },
      record: (id) => recorded.push(id),
      log: (m) => logs.push(m),
      // Ends the in-flight drain loop once overflow fires, instead of retrying forever with
      // real backoff delays — mirrors how `run()` wires `isStopped` to the same flag `shutdown`
      // sets, since a real overflow terminates the whole process.
      isStopped: () => overflowed,
      sleep: async () => {},
      cap: 3,
      onOverflow: (reason) => {
        overflowed = true;
        overflowCalls += 1;
        overflowReason = reason;
      },
    });

    // All four pushes run synchronously before the queue's own async drain loop (already
    // stuck retrying event 1, which never succeeds) gets a turn — so the cap check below is
    // exercised deterministically, with no reliance on timing.
    for (let id = 1; id <= 4; id += 1) queue.push({ id, text: `event ${id}` });

    assert.equal(queue.pending(), 3, "the 4th event is refused — the queue never grows past the cap");
    assert.equal(overflowCalls, 1, "onOverflow fires exactly once, not once per refused push");
    assert.match(overflowReason, /\b3\b/, "the reason names the cap that was hit");
    assert.ok(
      logs.some((m) => m.startsWith("FATAL:") && /\b3\b/.test(m)),
      "the overflow is logged loudly, not silently",
    );

    await queue.idle();
    assert.deepEqual(recorded, [], "the inbox never accepted a post, so nothing was ever recorded to the cursor");

    // A 5th push after the process would already be exiting must not resurrect delivery.
    queue.push({ id: 5, text: "event 5" });
    assert.equal(queue.pending(), 3);
    assert.equal(overflowCalls, 1);
  });

  test("cap defaults to RELAY_QUEUE_CAP, which matches the cursor's own CURSOR_ID_MEMORY", () => {
    assert.equal(bridge.RELAY_QUEUE_CAP, bridge.CURSOR_ID_MEMORY);
  });
});

// ------------------------------------------------ 9c. shutdown exit codes

describe("shutdown exit codes", () => {
  test("a fatal shutdown (overflow, or any bridge_failed exit) exits non-zero; a normal stop exits 0", () => {
    assert.equal(bridge.exitCodeForShutdown(true), 1);
    assert.equal(bridge.exitCodeForShutdown(false), 0);
    assert.equal(bridge.exitCodeForShutdown(undefined), 0);
  });

  test("classifyChildExit and superviseBridge agree on which reasons are fatal, feeding exitCodeForShutdown directly", async () => {
    // A clean stop record (e.g. SessionEnd-adjacent "not_connected") is never fatal.
    const clean = bridge.classifyChildExit({ stopped: { reason: "not_connected", detail: "d" }, code: 1, ranMs: 10 });
    assert.equal(bridge.exitCodeForShutdown(clean.fatal), 0);

    // A subcommand that died before ever producing a stop record IS fatal.
    const crashed = bridge.classifyChildExit({ stopped: null, code: 1, ranMs: 10 });
    assert.equal(bridge.exitCodeForShutdown(crashed.fatal), 1);

    // The relay queue's own overflow reason is what run() passes to shutdown() with
    // { fatal: true } — see "terminal shutdown mapping" below, which tests the actual
    // function run()'s two shutdown() call sites are built from, not a stand-in for it.
    assert.equal(bridge.exitCodeForShutdown(true), 1);
  });
});

// ---------------------------------------------------- 9d. terminal shutdown mapping

describe("terminal shutdown mapping", () => {
  test("an overflow reason is always fatal", () => {
    assert.deepEqual(bridge.terminalShutdown({ overflow: "relay queue overflow: 100 events undelivered" }), {
      why: "relay queue overflow: 100 events undelivered",
      fatal: true,
    });
  });

  test("a supervised bridge_failed exit is fatal", () => {
    const decision = bridge.classifyChildExit({ stopped: { reason: "bridge_failed", detail: "spawn ENOENT" }, code: null, ranMs: 10 });
    assert.deepEqual(bridge.terminalShutdown({ supervised: decision }), { why: "bridge_failed: spawn ENOENT", fatal: true });
  });

  test("a supervised not_connected stop is not fatal", () => {
    const decision = bridge.classifyChildExit({
      stopped: { reason: "not_connected", detail: "the session is not connected to a plan" },
      code: 1,
      ranMs: 10,
    });
    assert.deepEqual(bridge.terminalShutdown({ supervised: decision }), {
      why: "not_connected: the session is not connected to a plan",
      fatal: false,
    });
  });

  test("terminalShutdown's fatal flag feeds exitCodeForShutdown directly, for both terminal events", () => {
    assert.equal(bridge.exitCodeForShutdown(bridge.terminalShutdown({ overflow: "cap hit" }).fatal), 1);
    const clean = bridge.classifyChildExit({ stopped: { reason: "revoked", detail: "d" }, code: 1, ranMs: 10 });
    assert.equal(bridge.exitCodeForShutdown(bridge.terminalShutdown({ supervised: clean }).fatal), 0);
    const crashed = bridge.classifyChildExit({ stopped: null, code: 1, ranMs: 10 });
    assert.equal(bridge.exitCodeForShutdown(bridge.terminalShutdown({ supervised: crashed }).fatal), 1);
  });
});

// ---------------------------------------------------------- 10. start gate

describe("start gate", () => {
  test("missing environment or session id starts nothing", async () => {
    for (const [label, overrides, sessionId] of [
      ["no inbox socket", { CLAUDE_CODE_MESSAGING_SOCKET: "" }, SESSION],
      ["no inbox token", { CLAUDE_CODE_MESSAGING_TOKEN: "" }, SESSION],
      ["no plugin data", { CLAUDE_PLUGIN_DATA: "" }, SESSION],
      ["no session id", {}, undefined],
    ]) {
      let spawned = 0;
      const result = await bridge.start({
        env: env(tmpDir(), overrides),
        sessionId,
        intent: bridge.CONNECT_INTENT,
        spawnRun: () => ({ pid: ++spawned }),
        stderr: () => {},
        post: async () => {},
        waitVerdict: noVerdict,
      });
      assert.equal(result.started, false, label);
      assert.equal(spawned, 0, label);
    }
  });

  test("a missing or odd session id is never turned into a state path", () => {
    assert.throws(() => state.sessionPaths("/data", undefined), /session id is missing/);
    assert.throws(() => state.sessionPaths("/data", "../escape"), /unexpected characters/);
  });

  test("a session that is not connected ends the bridge on the first stop record, without a restart, and is not fatal", async () => {
    let spawns = 0;
    const { reason, fatal } = await bridge.superviseBridge({
      spawnChild: () => {
        spawns += 1;
        return fakeChild({ stdout: [recordLine({ type: "stopped", reason: "not_connected", detail: "the session is not connected to a plan" })], code: 1 });
      },
      relay: spyRelay().relay,
      log: () => {},
      now: () => 0,
      sleep: noSleep,
    });
    assert.equal(reason, "not_connected: the session is not connected to a plan");
    assert.equal(fatal, false);
    assert.equal(spawns, 1);
  });
});

// ------------------------------------------- 11. fail loud, in the session (DX-2862)

describe("failure notices", () => {
  test("a notice names the reason and the fix, and cannot be mistaken for a peer session's message", () => {
    const notice = failureText.failureNotice("the bridge could not start (missing X).", "do Y.");
    assert.ok(notice.startsWith(failureText.FAILURE_PREFIX));
    assert.match(notice, /events are NOT reaching this session: the bridge could not start \(missing X\)\. Fix: do Y\./);
  });

  test("a notice always carries a fix, even when the caller had none", () => {
    assert.match(failureText.failureNotice("something broke", ""), /Fix: \S.*\./);
  });

  test("every missing precondition has a remedy naming what to do about it", () => {
    for (const name of ["session id", ...bridge.REQUIRED_ENV]) {
      assert.ok(bridge.fixForMissing([name]).length > 10, name);
    }
  });

  test("announce puts the notice in the session's inbox", async () => {
    const posted = [];
    const errors = [];
    const result = await bridge.announce({
      reason: "r",
      fix: "f",
      env: env("/data"),
      post: async (content) => posted.push(content),
      stderr: (m) => errors.push(m),
    });
    assert.equal(result.posted, true);
    assert.equal(result.exitCode, 0);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /NOT reaching this session/);
    assert.deepEqual(errors, [], "a delivered notice is not also shouted at stderr");
  });

  test("a failing inbox is retried, then falls back to stderr with exit code 2", async () => {
    const errors = [];
    let attempts = 0;
    const result = await bridge.announce({
      reason: "r",
      fix: "f",
      env: env("/data"),
      post: async () => {
        attempts += 1;
        throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
      },
      stderr: (m) => errors.push(m),
    });
    assert.equal(attempts, bridge.SOCKET_POST_ATTEMPTS);
    assert.equal(result.posted, false);
    assert.equal(result.exitCode, 2);
    assert.match(errors.join(""), /NOT reaching this session/);
  });

  test("with no inbox at all the notice still goes somewhere — stderr, and exit code 2", async () => {
    const errors = [];
    let posts = 0;
    const result = await bridge.announce({
      reason: "the bridge could not start (missing CLAUDE_CODE_MESSAGING_SOCKET)",
      fix: "f",
      env: {},
      post: async () => {
        posts += 1;
      },
      stderr: (m) => errors.push(m),
    });
    assert.equal(posts, 0, "there is nothing to post to");
    assert.equal(result.exitCode, 2);
    assert.match(errors.join(""), /Fix: f\./);
  });

  test("a session that is not known to want plan events is not interrupted at all", async () => {
    const posted = [];
    const errors = [];
    const result = await bridge.announce({
      reason: "r",
      fix: "f",
      env: env("/data"),
      post: async (c) => posted.push(c),
      stderr: (m) => errors.push(m),
      relevant: false,
    });
    assert.deepEqual([posted, errors, result.exitCode, result.announced], [[], [], 0, false]);
  });
});

describe("which sessions hear about a failure", () => {
  test("a plan_connect always does — it just asked for these events", () => {
    assert.equal(bridge.isSessionKnownToWantEvents({ intent: bridge.CONNECT_INTENT, env: {}, sessionId: undefined }), true);
  });

  test("a session start does only once this session has been delivered events", () => {
    const dataDir = tmpDir();
    const sessionEnv = env(dataDir);
    assert.equal(bridge.isSessionKnownToWantEvents({ intent: bridge.RESUME_INTENT, env: sessionEnv, sessionId: SESSION }), false);
    bridge.recordDelivered(pathsFor(dataDir).cursor, 7);
    assert.equal(bridge.isSessionKnownToWantEvents({ intent: bridge.RESUME_INTENT, env: sessionEnv, sessionId: SESSION }), true);
  });

  test("a takeover by another listener is never announced; every other stop is", () => {
    for (const reason of ["superseded", "replaced"]) {
      assert.equal(bridge.shouldAnnounceStop(reason, { relevant: true }), false, reason);
    }
    for (const reason of [
      "not_connected",
      "unauthorized",
      "no_connection_record",
      "credential_unavailable",
      "credential_mismatch",
      "board_unreadable",
      "scope_check_failed",
      "mint_refused",
      "revoked",
      "refused",
      "bridge_failed",
    ]) {
      assert.equal(bridge.shouldAnnounceStop(reason, { relevant: true }), true, reason);
    }
    assert.equal(bridge.shouldAnnounceStop("credential_mismatch", { relevant: false }), false);
  });

  test("the PostToolUse hook means a connect; every other hook event means a resume", () => {
    assert.equal(bridge.intentFromHookEvent("PostToolUse"), bridge.CONNECT_INTENT);
    for (const name of ["SessionStart", "SessionEnd", undefined, ""]) {
      assert.equal(bridge.intentFromHookEvent(name), bridge.RESUME_INTENT, String(name));
    }
  });
});

describe("the hook's exit code carries what the inbox could not", () => {
  const collectStderr = () => {
    const errors = [];
    return { errors, stderr: (m) => errors.push(m) };
  };

  test("a bridge that is streaming exits 0, silently", () => {
    const { errors, stderr } = collectStderr();
    assert.deepEqual(bridge.startExit({ verdict: "ready" }, stderr), { verdict: "ready", exitCode: 0 });
    assert.deepEqual(errors, []);
  });

  test("a failure the bridge already delivered needs nothing further", () => {
    const { errors, stderr } = collectStderr();
    assert.deepEqual(
      bridge.startExit({ verdict: "failed", announced: true, posted: true, notice: "n" }, stderr),
      { verdict: "failed", exitCode: 0 },
    );
    assert.deepEqual(errors, [], "the session already has it — saying it twice trains people to ignore it");
  });

  test("a failure it could NOT deliver wakes Claude with exit 2 and the notice", () => {
    const { errors, stderr } = collectStderr();
    const notice = failureText.failureNotice("credential_mismatch: the bridge would authenticate as somebody else", "restart the session");
    assert.deepEqual(
      bridge.startExit({ verdict: "failed", announced: true, posted: false, notice }, stderr),
      { verdict: "failed", exitCode: 2 },
    );
    assert.match(errors.join(""), /credential_mismatch/);
  });

  test("a bridge that died before it started streaming is reported, not shrugged off", () => {
    const { errors, stderr } = collectStderr();
    assert.deepEqual(bridge.startExit({ verdict: "exited", code: 1 }, stderr), { verdict: "exited", exitCode: 2 });
    assert.match(errors.join(""), /exited \(code 1\)/);
  });

  test("no verdict in time leaves the bridge running and the hook quiet", () => {
    const { errors, stderr } = collectStderr();
    assert.deepEqual(bridge.startExit(null, stderr), { verdict: "pending", exitCode: 0 });
    assert.deepEqual(errors, []);
  });
});

describe("start waits for the bridge's own verdict", () => {
  const verdictChild = () => {
    const child = new EventEmitter();
    child.pid = 5150;
    child.unref = () => {};
    child.disconnect = () => {};
    return child;
  };

  test("the first verdict message ends the wait", async () => {
    const child = verdictChild();
    const waiting = bridge.waitForVerdict(child, 1_000);
    child.emit("message", { verdict: "ready" });
    assert.deepEqual(await waiting, { verdict: "ready" });
  });

  test("a bridge that exits first ends the wait too", async () => {
    const child = verdictChild();
    const waiting = bridge.waitForVerdict(child, 1_000);
    child.emit("exit", 1);
    assert.deepEqual(await waiting, { verdict: "exited", code: 1 });
  });

  test("the wait gives up rather than holding the hook open forever", async () => {
    assert.equal(await bridge.waitForVerdict(verdictChild(), 5), null);
  });

  test("a start whose bridge could not reach the session exits 2 with the notice", async () => {
    const dataDir = tmpDir();
    const errors = [];
    const notice = failureText.failureNotice("board_unreadable: cannot read board x:y", "scope the credential");
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      intent: bridge.CONNECT_INTENT,
      spawnRun: () => ({ pid: 5150 }),
      stderr: (m) => errors.push(m),
      waitVerdict: async () => ({ verdict: "failed", announced: true, posted: false, notice }),
    });
    assert.equal(result.started, true);
    assert.equal(result.exitCode, 2);
    assert.match(errors.join(""), /board_unreadable/);
  });

  test("a start whose bridge told the session itself exits 0", async () => {
    const dataDir = tmpDir();
    const errors = [];
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      intent: bridge.CONNECT_INTENT,
      spawnRun: () => ({ pid: 5150 }),
      stderr: (m) => errors.push(m),
      waitVerdict: async () => ({ verdict: "failed", announced: true, posted: true, notice: "n" }),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(errors, []);
  });
});

// ------------------------------------------------- 12. CLAUDE_PID liveness (DX-2894)

describe("readProcessStartKey (DX-2894 — async, timeout-bounded, three platforms)", () => {
  test("win32: parses the CIM CreationDate output in UTC", async () => {
    const calls = [];
    const execFileFn = (command, args, opts, cb) => {
      calls.push({ command, args, opts });
      cb(null, "2026-09-16T20:10:00.0000000Z\n", "");
    };
    const key = await bridge.readProcessStartKey(4242, { platform: "win32", execFileFn });
    assert.equal(key, "2026-09-16T20:10:00.0000000Z");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "powershell.exe");
    assert.match(calls[0].args.join(" "), /ToUniversalTime\(\)/, "the key must be read in UTC, never local time");
    assert.equal(calls[0].opts.timeout, bridge.START_KEY_READ_TIMEOUT_MS);
  });

  test("win32: empty output, a non-zero exit, and a timeout/spawn error all resolve null and report the real failure", async () => {
    const failures = [];
    const onFailure = (err) => failures.push(err);

    assert.equal(
      await bridge.readProcessStartKey(4242, { platform: "win32", execFileFn: (c, a, o, cb) => cb(null, "", ""), onFailure }),
      null,
    );
    assert.equal(
      await bridge.readProcessStartKey(4242, {
        platform: "win32",
        execFileFn: (c, a, o, cb) => cb(Object.assign(new Error("Command failed"), { code: 1 }), "", ""),
        onFailure,
      }),
      null,
    );
    assert.equal(
      await bridge.readProcessStartKey(4242, {
        platform: "win32",
        execFileFn: (c, a, o, cb) => cb(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", ""),
        onFailure,
      }),
      null,
    );
    assert.equal(failures.length, 3, "every unreadable case must report ITS OWN real error, not a generic one");
    assert.ok(
      failures.every((err) => err instanceof Error),
      "onFailure must receive the real error/reason, not a boolean",
    );
  });

  test("darwin: parses `ps -o lstart=` output, pinned to UTC/C, and the shared read timeout; an error resolves null and reports it", async () => {
    let seenOpts;
    const key = await bridge.readProcessStartKey(4242, {
      platform: "darwin",
      execFileFn: (command, args, opts, cb) => {
        assert.equal(command, "ps");
        assert.deepEqual(args, ["-o", "lstart=", "-p", "4242"]);
        seenOpts = opts;
        cb(null, "Mon Sep 16 20:10:00 2026\n", "");
      },
    });
    assert.equal(key, "darwin:Mon Sep 16 20:10:00 2026");
    // DX-2894: `ps -o lstart=` has no offset anywhere in its own output, so without an
    // explicit env override the read silently depends on the host's timezone/locale.
    assert.equal(seenOpts.env.TZ, "UTC", "darwin's start-key read must be pinned to UTC");
    assert.equal(seenOpts.env.LC_ALL, "C", "darwin's start-key read must be pinned to the C locale");
    assert.equal(seenOpts.timeout, bridge.START_KEY_READ_TIMEOUT_MS);

    const failures = [];
    assert.equal(
      await bridge.readProcessStartKey(4242, {
        platform: "darwin",
        execFileFn: (c, a, o, cb) => cb(new Error("No such process"), "", ""),
        onFailure: (err) => failures.push(err),
      }),
      null,
    );
    assert.equal(failures.length, 1);
  });

  // DX-2894: `ps` exiting 0 with EMPTY output (pid vanished between the alive check and the
  // read, or a `ps` build that silently declines) is a DIFFERENT failure shape than a
  // non-zero exit / spawn error, and needs its own coverage distinct from the win32
  // empty-output case (the "empty output, a non-zero exit, ..." test above).
  test("darwin: an exit-0 EMPTY `ps` output is also reported as a failure, not silently treated as success", async () => {
    const failures = [];
    const key = await bridge.readProcessStartKey(4242, {
      platform: "darwin",
      execFileFn: (c, a, o, cb) => cb(null, "", ""),
      onFailure: (err) => failures.push(err),
    });
    assert.equal(key, null);
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /no ps lstart output/);
  });

  // DX-2894: darwin's `timeoutMs` option must actually reach `execFile` — a custom timeout
  // that silently fell back to the default would only surface as a much harder-to-diagnose
  // hang under load.
  test("darwin: a custom timeoutMs is passed through to execFile, not just the default", async () => {
    let seenTimeout;
    await bridge.readProcessStartKey(4242, {
      platform: "darwin",
      timeoutMs: 12_345,
      execFileFn: (c, a, opts, cb) => {
        seenTimeout = opts.timeout;
        cb(null, "Mon Sep 16 20:10:00 2026\n", "");
      },
    });
    assert.equal(seenTimeout, 12_345);
  });

  // DX-2894: win32-only (there is no fake to fall back to — this proves the REAL CIM query
  // against the REAL current process). Skipped everywhere else, never simulated.
  test(
    "win32: a real CIM read against the running process returns a UTC key ending in Z",
    { skip: process.platform !== "win32" ? "win32-only: exercises the real CIM query" : false },
    async () => {
      const key = await bridge.readProcessStartKey(process.pid, {
        platform: "win32",
        // DX-2894: this test isn't testing the timeout value itself, so give the real CIM
        // query room beyond the production default (5s) — under load on a shared CI runner
        // it can comfortably exceed that bound and spuriously trip it.
        timeoutMs: 15_000,
      });
      assert.notEqual(key, null, "a real CIM read against this test's own live process must succeed");
      assert.match(key, /Z$/, "ToUniversalTime().ToString('o') must render a UTC ISO stamp ending in Z");
    },
  );

  test("linux: parses field 22 (starttime) out of /proc/<pid>/stat, tolerating a comm field with spaces and parens", async () => {
    const normal = "4242 (node) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 4 0 987654 1000 more fields follow";
    assert.equal(await bridge.readProcessStartKey(4242, { platform: "linux", readFile: async () => normal }), "linux:987654");

    const weirdComm = "4242 (some (odd) name) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 4 0 555555 x";
    assert.equal(await bridge.readProcessStartKey(4242, { platform: "linux", readFile: async () => weirdComm }), "linux:555555");

    const failures = [];
    assert.equal(
      await bridge.readProcessStartKey(4242, {
        platform: "linux",
        readFile: async () => {
          throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        },
        onFailure: (err) => failures.push(err),
      }),
      null,
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /no such file/);
  });

  test("an unsupported platform resolves null and reports a reason naming the platform, without ever reading anything", async () => {
    let reads = 0;
    // DX-2894: an assertion made INSIDE the `onFailure` callback never runs — and so never
    // fails the test — if `onFailure` itself is never called at all; only recording every
    // call and asserting the count separately proves it fired exactly once.
    const failures = [];
    const key = await bridge.readProcessStartKey(4242, {
      platform: "freebsd",
      execFileFn: () => {
        reads += 1;
      },
      readFile: async () => {
        reads += 1;
        return "";
      },
      onFailure: (err) => failures.push(err),
    });
    assert.equal(key, null);
    assert.equal(reads, 0, "an unsupported platform must not attempt any OS call");
    assert.equal(failures.length, 1, "onFailure must be called exactly once");
    assert.match(failures[0].message, /freebsd/);
  });

  test("a non-positive-integer pid is refused without reading anything, and reports it through onFailure", async () => {
    let execCalls = 0;
    const execFileFn = (c, a, o, cb) => {
      execCalls += 1;
      cb(null, "x", "");
    };
    let readFileCalls = 0;
    const readFile = async () => {
      readFileCalls += 1;
      return "";
    };
    const failures = [];
    const onFailure = (err) => failures.push(err);
    assert.equal(await bridge.readProcessStartKey(0, { platform: "win32", execFileFn, onFailure }), null);
    assert.equal(await bridge.readProcessStartKey(-1, { platform: "linux", readFile, onFailure }), null);
    assert.equal(await bridge.readProcessStartKey(1.5, { platform: "win32", execFileFn, onFailure }), null);
    assert.equal(execCalls, 0, "win32 must not attempt any OS call for an invalid pid");
    // DX-2894: without a call count on the linux `readFile` stub too, a broken guard that
    // still refused the win32 pids (via `execCalls`) while silently reading `/proc/-1/stat`
    // would pass this test — the same "reads nothing" claim must hold per platform, not just
    // for whichever platform happens to be checked first.
    assert.equal(readFileCalls, 0, "linux must not attempt any OS call for an invalid pid");
    // DX-2894: the docstring promises `onFailure` fires whenever the function resolves null —
    // an invalid pid is one such case, and must not be a silent exception to that contract.
    assert.equal(failures.length, 3, "onFailure must be called for every invalid-pid resolution, not just OS-level read failures");
  });
});

describe("describeProcessError (DX-2894)", () => {
  test("a plain error renders just its message", () => {
    assert.equal(bridge.describeProcessError(new Error("no such process")), "no such process");
  });

  test("a timeout kill (execFile's own shape: killed + signal + code) reads as a timeout, not a generic failure", () => {
    const err = Object.assign(new Error("Command failed: ps -o lstart= -p 4242"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    const described = bridge.describeProcessError(err);
    assert.match(described, /Command failed/);
    assert.match(described, /killed=true/);
    assert.match(described, /signal=SIGTERM/);
    assert.doesNotMatch(described, /code=/, "a null/absent code must not render as the literal string 'null'");
  });

  test("a non-zero exit carries its code, with no killed/signal fields to a clean failure", () => {
    const err = Object.assign(new Error("Command failed"), { code: 1 });
    const described = bridge.describeProcessError(err);
    assert.match(described, /Command failed/);
    assert.match(described, /code=1/);
    assert.doesNotMatch(described, /killed=/);
    assert.doesNotMatch(described, /signal=/);
  });

  test("a nullish error still renders a string, never throws", () => {
    assert.equal(bridge.describeProcessError(null), "unknown error");
    assert.equal(bridge.describeProcessError(undefined), "unknown error");
  });
});

describe("unsupportedPlatformNotice (DX-2894)", () => {
  test("names the platform explicitly in both the reason and the fix", () => {
    const { reason, fix } = bridge.unsupportedPlatformNotice("freebsd");
    assert.match(reason, /freebsd/);
    assert.match(fix, /freebsd/);
    for (const platform of bridge.SUPPORTED_START_KEY_PLATFORMS) assert.match(fix, new RegExp(platform));
  });
});

describe("verifyStartKeyTick (DX-2894 — pure, no process or timer)", () => {
  test("a dead pid is left to the cheap isAlive tick — the key is never even read", async () => {
    const result = await bridge.verifyStartKeyTick(1234, "a", {
      isAlive: () => false,
      readProcessStartKey: () => {
        throw new Error("must not be called");
      },
      unreadableCount: 2,
    });
    assert.deepEqual(result, { action: "none", unreadableCount: 2 }, "the count is untouched, not silently reset");
  });

  test("a live pid whose key still matches is fine, and resets any prior unreadable count", async () => {
    const result = await bridge.verifyStartKeyTick(1234, "a", {
      isAlive: () => true,
      readProcessStartKey: async () => "a",
      unreadableCount: 2,
    });
    assert.deepEqual(result, { action: "none", unreadableCount: 0 });
  });

  test("a live pid whose key differs is a reused pid, unconditionally (not gated on the unreadable counter)", async () => {
    const result = await bridge.verifyStartKeyTick(1234, "a", {
      isAlive: () => true,
      readProcessStartKey: async () => "b",
      unreadableCount: 0,
    });
    assert.deepEqual(result, { action: "reused", unreadableCount: 0 });
  });

  test("a single unreadable read is NOT gone — it increments the counter and reports the real error, but takes no action", async () => {
    const attempts = [];
    const result = await bridge.verifyStartKeyTick(1234, "a", {
      isAlive: () => true,
      readProcessStartKey: async (pid, { onFailure }) => {
        onFailure(new Error("CIM query timed out"));
        return null;
      },
      unreadableCount: 0,
      unreadableLimit: 3,
      onUnreadableAttempt: (err, attempt, limit) => attempts.push({ message: err.message, attempt, limit }),
    });
    assert.deepEqual(result, { action: "none", unreadableCount: 1 });
    assert.deepEqual(attempts, [{ message: "CIM query timed out", attempt: 1, limit: 3 }]);
  });

  test("a transient failure that recovers resets the counter to zero rather than accumulating toward the limit", async () => {
    let call = 0;
    const readKey = async (pid, { onFailure }) => {
      call += 1;
      if (call === 1) {
        onFailure(new Error("transient"));
        return null;
      }
      return "a"; // matches expected — recovers
    };
    const first = await bridge.verifyStartKeyTick(1234, "a", { isAlive: () => true, readProcessStartKey: readKey, unreadableCount: 0 });
    assert.deepEqual(first, { action: "none", unreadableCount: 1 });
    const second = await bridge.verifyStartKeyTick(1234, "a", {
      isAlive: () => true,
      readProcessStartKey: readKey,
      unreadableCount: first.unreadableCount,
    });
    assert.deepEqual(second, { action: "none", unreadableCount: 0 }, "a successful read resets the counter, even after a prior failure");
  });

  test("exhausting unreadableLimit CONSECUTIVE unreadable attempts is unverifiable — fatal, and distinct from 'reused' or a plain miss", async () => {
    const readKey = async (pid, { onFailure }) => {
      onFailure(new Error("still unreadable"));
      return null;
    };
    let count = 0;
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await bridge.verifyStartKeyTick(1234, "a", {
        isAlive: () => true,
        readProcessStartKey: readKey,
        unreadableCount: count,
        unreadableLimit: 3,
      });
      count = last.unreadableCount;
    }
    assert.deepEqual(last, { action: "unverifiable", unreadableCount: 3 });
  });
});

describe("run(): CLAUDE_PID liveness — two cadences, end-to-end (DX-2894)", () => {
  const fixturePath = path.join(here, "fixtures", "run-bridge.mjs");

  // Every process this describe block spawns is tracked here and force-killed in `after()`.
  // A per-test `finally` is still the primary cleanup path (keeps the machine tidy while the
  // suite runs); this set is strictly the last-resort backstop for when an assertion throws
  // before its own `finally` runs, which would otherwise leak a stand-in or fixture process.
  const spawnedForCleanup = new Set();
  function track(child) {
    spawnedForCleanup.add(child);
    child.once("exit", () => spawnedForCleanup.delete(child));
    return child;
  }
  after(() => {
    for (const child of spawnedForCleanup) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  function onceWithTimeout(emitter, event, timeoutMs, label) {
    return Promise.race([
      once(emitter, event),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label ?? event}`)), timeoutMs)),
    ]);
  }

  async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async function inboxServer() {
    const address =
      process.platform === "win32"
        ? `\\\\.\\pipe\\peb-fixture-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
        : path.join(tmpDir(), "inbox.sock");
    const received = [];
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line) received.push(JSON.parse(line));
          nl = buf.indexOf("\n");
        }
      });
    });
    await new Promise((resolve) => server.listen(address, resolve));
    // DX-2894: idempotent — `server.close()` throws `ERR_SERVER_NOT_RUNNING` on a second call,
    // and a test that wants to close the server itself (to settle pending connections before
    // asserting on `received`, rather than only in its `finally`) needs to be able to call
    // `close()` early without making the `finally`'s own `close()` throw.
    let closed = false;
    const close = () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        server.close(resolve);
      });
    return { address, received, close };
  }

  /** Waits for the bridge's own "bridge started" log line — timing assertions must be
   * anchored to the bridge's own evidence that it has armed its checks, never a fixed guess
   * at how long that takes. */
  async function waitForBridgeStarted(dataDir, opts) {
    const paths = pathsFor(dataDir);
    // DX-2894: the "bridge started" log line is written only AFTER the startup start-key
    // read resolves, and that read is itself bounded by START_KEY_READ_TIMEOUT_MS (5s) — the
    // wait budget here must stay comfortably above that bound, not equal to it, so a real OS
    // read running close to its own timeout doesn't also race this wait. Still overridable
    // via `opts`.
    assert.ok(
      await waitFor(() => {
        try {
          return /bridge started for session/.test(fs.readFileSync(paths.log, "utf8"));
        } catch {
          return false;
        }
      }, { timeoutMs: bridge.START_KEY_READ_TIMEOUT_MS + 7_000, ...opts }),
      "bridge never logged 'bridge started'",
    );
    return paths;
  }

  function spawnFixture({
    dataDir,
    sessionId = SESSION,
    intent = "resume",
    claudePid,
    // DX-2953: `start()` always sets DANX_BRIDGE_INSTANCE_ID before spawning a real
    // run process — every existing test in this describe block simulates that by
    // defaulting it here; pass `instanceId: null` explicitly to omit it.
    instanceId = "fixture-instance-id",
    parentCheckMs,
    startKeyCheckMs,
    startKeyTimeoutMs,
    unreadableLimit,
    reuseAfterCalls,
    startupUnreadable,
    unreadableAfterStartup,
    instrumentStartKey,
    slowUnreadable,
    slowUnreadableDelayMs,
    parentDiesDuringStartupRead,
    platform,
    inboxAddress,
  }) {
    const fixtureEnv = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CODE_MESSAGING_SOCKET: inboxAddress,
      CLAUDE_CODE_MESSAGING_TOKEN: "inbox-secret",
      RUN_BRIDGE_FIXTURE_CONFIG: JSON.stringify({
        sessionId,
        intent,
        parentCheckMs,
        startKeyCheckMs,
        startKeyTimeoutMs,
        unreadableLimit,
        reuseAfterCalls,
        startupUnreadable,
        unreadableAfterStartup,
        instrumentStartKey,
        slowUnreadable,
        slowUnreadableDelayMs,
        parentDiesDuringStartupRead,
        platform,
      }),
    };
    if (claudePid === undefined) delete fixtureEnv.CLAUDE_PID;
    else fixtureEnv.CLAUDE_PID = String(claudePid);
    // NOTE: a destructured default only applies on `undefined`, so pass
    // `instanceId: null` (never `undefined`) to omit it.
    if (instanceId === null) delete fixtureEnv.DANX_BRIDGE_INSTANCE_ID;
    else fixtureEnv.DANX_BRIDGE_INSTANCE_ID = instanceId;
    return track(spawn(process.execPath, [fixturePath], { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] }));
  }

  /** DX-2894: index 1 is the one-time STARTUP read (the same `readProcessStartKey` override
   * `run()` reuses before it ever arms the periodic timer) — only index >= 2 proves the
   * PERIODIC cadence itself ran and succeeded. */
  function hasPeriodicStartKeyCheckOk(output) {
    return [...output.matchAll(/fixture-start-key-check index=(\d+) result=(ok|null)/g)].some(
      (m) => Number(m[1]) >= 2 && m[2] === "ok",
    );
  }

  /** DX-2894: every `finally`-block cleanup kill in this describe block goes through here.
   * `killTree()` (win32: `taskkill /PID ... /T /F`) and `ChildProcess#kill()` both act purely
   * on a pid number — once a process has actually exited, the OS is free to hand that same
   * pid to an unrelated process, and an unguarded cleanup kill run afterward is a real risk of
   * tearing down something that was never part of this test, on the dev machine running the
   * suite. `target` is either a tracked `ChildProcess` (its own `exitCode`/`signalCode` settle
   * immediately once it has exited — no OS call needed) or a bare pid captured from a
   * fixture's own stdout report (no local `ChildProcess` handle exists for it, so
   * `bridge.isAlive` is the only liveness signal available). */
  function killIfAlive(target, { tree = false } = {}) {
    if (typeof target === "number") {
      if (bridge.isAlive(target)) bridge.killTree(target);
      return;
    }
    if (target.exitCode !== null || target.signalCode !== null) return;
    if (tree) bridge.killTree(target.pid);
    else target.kill();
  }

  test("a hard-killed CLAUDE_PID stand-in makes the bridge shut down within a bounded number of isAlive ticks, removes its pid file, and ends its own stub child", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const parentCheckMs = 250;
    const fixture = spawnFixture({ dataDir, claudePid: standIn.pid, parentCheckMs, inboxAddress: address });
    let out = "";
    fixture.stdout.on("data", (chunk) => (out += chunk));
    fixture.stderr.resume();

    try {
      assert.ok(await waitFor(() => /fixture-ready/.test(out)), "fixture did not report ready");
      const paths = await waitForBridgeStarted(dataDir);
      assert.equal(fs.existsSync(paths.pid), true, "pid file written while the bridge is armed");
      assert.ok(await waitFor(() => /fixture-child-pid=(\d+)/.test(out)), "the stub subcommand never reported its pid");
      const stubChildPid = Number(out.match(/fixture-child-pid=(\d+)/)[1]);

      const killedAt = Date.now();
      standIn.kill();
      await onceWithTimeout(standIn, "exit", 5_000, "stand-in exit");

      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      const elapsedMs = Date.now() - killedAt;
      // DX-2894: the budget is `parentCheckMs * 4 + 5_000`, not one bare interval — the cheap
      // isAlive tick can land just after `standIn.kill()`, so up to a few ticks can elapse
      // before the check that actually observes the pid as gone; the 5s of fixed slack on top
      // covers ordinary OS process-teardown latency on a loaded CI runner. Neither term is a
      // CIM query — `isAlive` is a bare `process.kill(pid, 0)`, not the start-key read.
      assert.ok(
        elapsedMs < parentCheckMs * 4 + 5_000,
        `expected shutdown within a bounded number of isAlive ticks, took ${elapsedMs}ms`,
      );
      assert.equal(code, 0, "a parent-gone shutdown is a normal, non-fatal stop");
      assert.equal(fs.existsSync(paths.pid), false, "pid file removed on shutdown");
      assert.match(fs.readFileSync(paths.log, "utf8"), new RegExp(`Claude Code process ${standIn.pid} exited`));
      assert.equal(
        await waitFor(() => !bridge.isAlive(stubChildPid), { timeoutMs: 5_000 }),
        true,
        "the stub bridge subcommand must be killed along with the bridge",
      );
    } finally {
      killIfAlive(fixture, { tree: true });
      await close();
    }
  });

  test("a missing CLAUDE_PID is a loud refusal to start: non-zero exit and a notice naming CLAUDE_PID", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    // intent "connect" (a plan_connect) is what `isSessionKnownToWantEvents` treats as
    // KNOWN to want this session told — a plain "resume" with no prior cursor is not
    // (DX-2862), which would make the inbox assertion below correctly fail for an
    // unrelated reason. The exit-code half of this AC holds for either intent.
    const fixture = spawnFixture({ dataDir, claudePid: undefined, intent: "connect", inboxAddress: address });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 1, "a missing CLAUDE_PID must exit non-zero, never a silent warning");
      assert.ok(await waitFor(() => received.some((frame) => frame.type === "user")), "no notice reached the session's inbox");
      const notice = received.find((frame) => frame.type === "user");
      assert.match(notice.message.content, /CLAUDE_PID/);
    } finally {
      killIfAlive(fixture, { tree: true });
      await close();
    }
  });

  test("a CLAUDE_PID that is already dead at startup takes the normal 'exited' stop, not the fatal 'could not read start time' refusal", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const deadPid = standIn.pid;
    standIn.kill();
    await onceWithTimeout(standIn, "exit", 5_000, "stand-in exit");
    // intent "connect" so a fatal refusal (if the bug were present) would also be posted to
    // the inbox — proving the ABSENCE of that notice below is meaningful, not just untested.
    const fixture = spawnFixture({ dataDir, claudePid: deadPid, intent: "connect", inboxAddress: address });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 0, "a parent already dead at startup is a normal, non-fatal stop — not the fatal read-failure refusal");
      const paths = pathsFor(dataDir);
      // DX-2894: `fs.existsSync(paths.pid) === false` alone can't distinguish "never created"
      // from "created by beat() then removed by shutdown()" — both end in the same absence.
      // Assert instead that the log carries no "bridge started" line, which `run()` writes
      // only AFTER `beat()` first runs — its absence is what actually proves the heartbeat
      // (and so the pid file write) never happened.
      const logContent = fs.readFileSync(paths.log, "utf8");
      assert.doesNotMatch(
        logContent,
        /bridge started for session/,
        "the guard must refuse before the first heartbeat write — a 'bridge started' line would mean beat() already ran",
      );
      assert.equal(fs.existsSync(paths.pid), false, "pid file never created");
      assert.match(logContent, new RegExp(`Claude Code process ${deadPid} exited`));
      // DX-2894: nobody is left to read a notice for an already-dead session, so this must
      // never take the "could not read the start time" fatal refusal path, which DOES post one.
      // The fixture process has already exited by this point (awaited above), but that alone
      // doesn't rule out a still-in-flight connection the server hasn't finished receiving —
      // closing the server first and awaiting it settles every already-established connection
      // (each notice write ends with `sock.end()`, so `close()`'s callback only fires once any
      // such connection has fully ended) before `received` is read, so an absent notice here
      // is a real absence, not a race that happened to not lose.
      await close();
      assert.equal(
        received.some((frame) => frame.type === "user"),
        false,
        "a dead-at-startup parent must not post the fatal 'could not read start time' notice",
      );
    } finally {
      killIfAlive(fixture, { tree: true });
      await close();
    }
  });

  test("a parent that dies between the startup alive() check and the start-key read is a normal 'exited' stop, not the fatal read-failure refusal", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    // intent "connect" so a fatal refusal (if the bug were present) would also be posted to
    // the inbox — proving the ABSENCE of that notice below is meaningful, not just untested.
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      intent: "connect",
      parentDiesDuringStartupRead: true,
      inboxAddress: address,
    });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(
        code,
        0,
        "a parent that dies between the alive() check and the start-key read is a normal, non-fatal stop",
      );
      const paths = pathsFor(dataDir);
      assert.doesNotMatch(
        fs.readFileSync(paths.log, "utf8"),
        /bridge started for session/,
        "the guard must refuse before the first heartbeat write — a 'bridge started' line would mean beat() already ran",
      );
      assert.equal(fs.existsSync(paths.pid), false, "pid file never created");
      assert.match(fs.readFileSync(paths.log, "utf8"), new RegExp(`Claude Code process ${standIn.pid} exited`));
      await close();
      assert.equal(
        received.some((frame) => frame.type === "user"),
        false,
        "a parent gone mid-startup must not post the fatal 'could not read start time' notice",
      );
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("an unreadable start key AT STARTUP is a loud refusal, distinct from a missing CLAUDE_PID", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      intent: "connect",
      startupUnreadable: true,
      inboxAddress: address,
    });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 1, "an unreadable start key at startup must exit non-zero, never silently skip the guard");
      assert.ok(await waitFor(() => received.some((frame) => frame.type === "user")), "no notice reached the session's inbox");
      const notice = received.find((frame) => frame.type === "user");
      assert.match(notice.message.content, /start time of Claude Code process/);
      // DX-2894: the notice must name the LAST underlying read error, not just that the
      // guard tripped — the session sees only this notice, never the bridge's own log file.
      assert.match(notice.message.content, /stub: simulated unreadable start key/);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("a live CLAUDE_PID stand-in is never stopped, across several isAlive ticks AND at least one real PERIODIC start-key verification", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const parentCheckMs = 60;
    // DX-2894: a real CIM/`ps` query can comfortably exceed a tight cadence on a loaded CI
    // box, which would starve the periodic cadence of ever landing a second tick inside this
    // test's own wait window — this value isn't itself under test, so give it room.
    const startKeyCheckMs = 500;
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      parentCheckMs,
      startKeyCheckMs,
      // DX-2894: this test drives the REAL platform start-key read (via `instrumentStartKey`)
      // with the default START_KEY_READ_TIMEOUT_MS otherwise — a value this test isn't
      // testing — so give it room beyond the production default for a loaded CI runner.
      startKeyTimeoutMs: 15_000,
      instrumentStartKey: true,
      inboxAddress: address,
    });
    let out = "";
    fixture.stdout.on("data", (chunk) => (out += chunk));
    fixture.stderr.resume();
    let exited = false;
    fixture.once("exit", () => {
      exited = true;
    });

    try {
      // DX-2894: this test's own `startKeyTimeoutMs` above is 15s — the default wait budget
      // (`START_KEY_READ_TIMEOUT_MS` + 7s = 12s) would race a real OS read running close to
      // ITS bound, so derive the wait from the same configured timeout this fixture actually
      // uses rather than the production default.
      await waitForBridgeStarted(dataDir, { timeoutMs: 15_000 + 7_000 });
      assert.ok(await waitFor(() => /fixture-child-pid=(\d+)/.test(out)), "the stub subcommand never reported its pid");
      // DX-2894: index 1 — the one-time STARTUP read — uses this exact same
      // `readProcessStartKey` override and always logs before the periodic timer is even
      // armed, so accepting ANY "result=ok" line would pass even with the periodic check
      // never running at all. Require index >= 2: a result only the PERIODIC cadence can
      // produce.
      assert.ok(
        await waitFor(() => hasPeriodicStartKeyCheckOk(out), { timeoutMs: 15_000 }),
        "no PERIODIC (index >= 2) start-key verification succeeded — index 1 is only the one-time startup read",
      );
      await new Promise((resolve) => setTimeout(resolve, parentCheckMs * 10));
      assert.equal(exited, false, "a live parent must never trigger a shutdown");
    } finally {
      // DX-2894: `killTree(fixture.pid)` (win32: `taskkill /T /F`) walks the real OS child
      // tree, so it ends the fixture's own stub subcommand along with it without needing the
      // stub's own pid parsed out of stdout first — a `waitFor` for that pid can sit anywhere
      // in the `try` above, so cleanup must not depend on having reached it.
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("a reused pid (a different start key on a later check than at startup) is treated as gone, and the log names the reason", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    // A REAL live stand-in — `verifyStartKeyTick` checks `isAlive(pid)` before ever
    // reading the key, so a fake never-existed pid would short-circuit to "none" and this
    // test would never exercise reuse detection at all. Only the KEY read is stubbed.
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const startKeyCheckMs = 100;
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      startKeyCheckMs,
      reuseAfterCalls: 1,
      inboxAddress: address,
    });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 0, "a detected pid reuse is a normal, non-fatal stop, exactly like a genuinely gone parent");
      const paths = pathsFor(dataDir);
      assert.equal(fs.existsSync(paths.pid), false, "pid file removed on shutdown");
      assert.match(fs.readFileSync(paths.log, "utf8"), /was reused by another process/);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("N consecutive unreadable start-key checks (pid alive throughout) is a fatal stop worded 'could not be verified', never 'gone'", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const startKeyCheckMs = 60;
    const unreadableLimit = 2;
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      intent: "connect",
      startKeyCheckMs,
      unreadableLimit,
      unreadableAfterStartup: true,
      inboxAddress: address,
    });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 1, "exhausting the unreadable-attempt tolerance must exit non-zero (fatal)");
      assert.ok(await waitFor(() => received.some((frame) => frame.type === "user")), "no notice reached the session's inbox");
      const notice = received.find((frame) => frame.type === "user");
      assert.match(notice.message.content, /could not be verified/);
      assert.doesNotMatch(notice.message.content, /\bgone\b/i, "an unverifiable liveness must never be worded as 'gone'");
      // DX-2894: the periodic fatal notice must ALSO name the last underlying read error,
      // exactly like the startup one above.
      assert.match(notice.message.content, /stub: simulated unreadable start key/);
      const paths = pathsFor(dataDir);
      assert.equal(fs.existsSync(paths.pid), false, "pid file removed on shutdown");
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("start-key checks are non-overlapping: a slow read never has a second one in flight, and the count still reaches the unverifiable limit", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    // Deliberately read-delay >> tick cadence: a scheduler that only reschedules once the
    // current read settles must never start a second (or third...) read while the first is
    // still pending, however small the cadence is relative to the read.
    const startKeyCheckMs = 30;
    const slowUnreadableDelayMs = 200;
    const unreadableLimit = 3;
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      intent: "connect",
      startKeyCheckMs,
      unreadableLimit,
      slowUnreadable: true,
      slowUnreadableDelayMs,
      inboxAddress: address,
    });
    let out = "";
    fixture.stdout.on("data", (chunk) => (out += chunk));
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 10_000, "fixture exit");
      assert.equal(code, 1, "exhausting the unreadable-attempt tolerance must still be reached and still exit fatal");
      assert.doesNotMatch(out, /fixture-slow-read-OVERLAP/, "a second slow read must never start while the first is still pending");
      // DX-2894: reconstruct the non-overlap guarantee from each line's OWN POSITION in the
      // captured output stream, independent of the stub's own inFlight counter. Comparing the
      // two call-number arrays for equality proves only that the same set of calls started and
      // ended — it would pass even for a completely scrambled interleaving, e.g. every start
      // logged up front and every end logged afterward. What must actually hold is ORDER: each
      // call's own end line appears before the NEXT call's start line, so no two reads are
      // ever in flight together.
      const starts = [...out.matchAll(/fixture-slow-read-start calls=(\d+)/g)];
      const ends = [...out.matchAll(/fixture-slow-read-end calls=(\d+)/g)];
      assert.ok(starts.length >= unreadableLimit, `expected at least ${unreadableLimit} slow reads, saw ${starts.length}`);
      for (let i = 0; i < starts.length; i += 1) {
        const call = Number(starts[i][1]);
        const end = ends.find((m) => Number(m[1]) === call);
        assert.ok(end, `call ${call} started but never logged its own end`);
        assert.ok(end.index > starts[i].index, `call ${call}'s end must appear after its own start`);
        if (i + 1 < starts.length) {
          assert.ok(
            end.index < starts[i + 1].index,
            `call ${call}'s end must appear before call ${call + 1}'s start — a start before this end would mean two reads were in flight at once`,
          );
        }
      }
      assert.ok(await waitFor(() => received.some((frame) => frame.type === "user")), "no notice reached the session's inbox");
      const notice = received.find((frame) => frame.type === "user");
      assert.match(notice.message.content, /could not be verified/);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("an unsupported platform is a loud refusal at run() level too, never a silent skip of the liveness guard", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      intent: "connect",
      platform: "freebsd",
      inboxAddress: address,
    });
    fixture.stdout.resume();
    fixture.stderr.resume();

    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 1, "an unsupported platform must exit non-zero, never a silent skip of the guard");
      assert.ok(await waitFor(() => received.some((frame) => frame.type === "user")), "no notice reached the session's inbox");
      const notice = received.find((frame) => frame.type === "user");
      // DX-2894: assert the SPECIFIC unsupported-platform wording (`unsupportedPlatformNotice`),
      // not just that SOME notice arrived — asserting only "a notice happened" would still pass
      // even if the unsupported-platform guard were removed entirely, since a live standIn on
      // an unrecognized platform still runs every OTHER startup check and could produce a
      // different fatal notice by some other path.
      assert.match(notice.message.content, /not supported by the plan event bridge's liveness check/);
      assert.match(notice.message.content, /freebsd/);
      assert.doesNotMatch(
        notice.message.content,
        /restart the session/,
        "the unsupported-platform notice is its own wording, never the CLAUDE_PID 'exited'/'unverifiable' stop-path wording",
      );
      const paths = pathsFor(dataDir);
      // DX-2894: `fs.existsSync(paths.pid) === false` alone can't distinguish "never created"
      // from "created by beat() then removed by shutdown()" — both end in the same absence.
      // Assert instead that the log carries no "bridge started" line, which `run()` writes
      // only AFTER `beat()` first runs — its absence is what actually proves the heartbeat
      // (and so the pid file write) never happened.
      assert.doesNotMatch(
        fs.readFileSync(paths.log, "utf8"),
        /bridge started for session/,
        "the guard must refuse before the first heartbeat write — a 'bridge started' line would mean beat() already ran",
      );
      assert.equal(fs.existsSync(paths.pid), false, "pid file never created");
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });
});

// --------------------------------------------------------------- pruning

test("stale state files are pruned; fresh ones and other files are kept", () => {
  const dataDir = tmpDir();
  const dir = state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir });
  const old = new Date(Date.now() - bridge.STALE_STATE_MS - 60_000);
  const oldFiles = ["a.log", "a.pid.json", "a.cursor.json", "a.lock", "a.pid.json.1.2.tmp"];
  const freshFiles = ["b.log", "b.pid.json", "b.cursor.json"];
  for (const name of [...oldFiles, ...freshFiles, "notes.txt"]) fs.writeFileSync(path.join(dir, name), "{}");
  for (const name of [...oldFiles, "notes.txt"]) fs.utimesSync(path.join(dir, name), old, old);
  bridge.pruneStale(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...freshFiles, "notes.txt"].sort());
});

// ============================================================= DX-2953: watchdog markers
//
// The watchdog itself (decision, throttle, tick, real-process lifecycle) is tested in
// bridge-watchdog.test.mjs (DX-3997 moved it out of the bridge). What stays here is what the
// BRIDGE writes for it: the `.started.json` record `start()` builds and the `.connected.json`
// marker the run process writes.

describe("buildStartedRecord (DX-2953)", () => {
  test("a non-watchdog start (SessionStart / plan_connect) always resets generation and consumed instance to fresh", () => {
    const prev = started({ restartGeneration: 3, consumedStopInstance: "old-instance" });
    const rec = bridge.buildStartedRecord({ instanceId: "instance-new", sessionId: SESSION, intent: "connect", prevStarted: prev, stoppedRecord: null, restartTrigger: undefined, now: NOW });
    assert.equal(rec.lastStartedInstance, "instance-new");
    assert.equal(rec.restartGeneration, 0);
    assert.equal(rec.consumedStopInstance, null);
    assert.equal(rec.startInputs.sessionId, SESSION);
    assert.equal(rec.startInputs.intent, "connect");
  });
  test("a watchdog restart bumps the effective generation by one and records the consumed instance", () => {
    const prev = started({ restartGeneration: 0 });
    const rec = bridge.buildStartedRecord({
      instanceId: "instance-new",
      sessionId: SESSION,
      intent: "resume",
      prevStarted: prev,
      stoppedRecord: null,
      restartTrigger: "watchdog",
      consumeStopInstance: "instance-a",
      now: NOW,
    });
    assert.equal(rec.restartGeneration, 1);
    assert.equal(rec.consumedStopInstance, "instance-a");
  });
  test("a watchdog restart with no consumed instance (plain stale-no-record case) records null", () => {
    const rec = bridge.buildStartedRecord({ instanceId: "instance-new", sessionId: SESSION, intent: "resume", prevStarted: null, stoppedRecord: null, restartTrigger: "watchdog", now: NOW });
    assert.equal(rec.consumedStopInstance, null);
    assert.equal(rec.restartGeneration, 1);
  });
  test("carries transcriptPath through into startInputs verbatim (null when absent)", () => {
    const rec = bridge.buildStartedRecord({ instanceId: "i", sessionId: SESSION, intent: "resume", transcriptPath: "/tmp/transcript.jsonl", prevStarted: null, stoppedRecord: null, now: NOW });
    assert.equal(rec.startInputs.transcriptPath, "/tmp/transcript.jsonl");
    const rec2 = bridge.buildStartedRecord({ instanceId: "i", sessionId: SESSION, intent: "resume", prevStarted: null, stoppedRecord: null, now: NOW });
    assert.equal(rec2.startInputs.transcriptPath, null);
  });
});

describe("CONNECTED_WRITE_SKIP_REASONS / writeConnectedMarker semantics (DX-2953)", () => {
  test("no_connection_record, credential_unavailable, session_is_worker and bridge_failed are the exact skip set", () => {
    assert.deepEqual([...bridge.CONNECTED_WRITE_SKIP_REASONS].sort(), ["bridge_failed", "credential_unavailable", "no_connection_record", "session_is_worker"].sort());
  });
  test("writeConnectedMarker writes connected/instanceId/at, atomically", () => {
    const dataDir = tmpDir();
    const file = pathsFor(dataDir).connected;
    bridge.writeConnectedMarker(file, { connected: true, instanceId: "i-1", now: Date.parse("2026-09-21T00:00:00.000Z") });
    assert.deepEqual(state.readJsonFile(file), { connected: true, instanceId: "i-1", at: "2026-09-21T00:00:00.000Z" });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")), []);
  });
});

describe("writeConnectedIfCurrent — the .pid.json instance fence (DX-2953 concurrency)", () => {
  test("writes when .pid.json's instanceId still matches the caller's own", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: 1, sessionId: SESSION, heartbeatAt: new Date().toISOString(), instanceId: "instance-a" }));
    const result = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId: "instance-a", now: Date.now() });
    assert.equal(result.written, true);
    assert.equal(state.readJsonFile(paths.connected).connected, true);
  });
  test("refuses when .pid.json has since been claimed by a DIFFERENT instance (a superseded run process's late write)", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    // Simulates: instance A's run process is about to write .connected.json
    // (e.g. its own ready-write), but a `plan_connect` start() already
    // replaced the holder with instance B before A's write lands.
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: 2, sessionId: SESSION, heartbeatAt: new Date().toISOString(), instanceId: "instance-b" }));
    const result = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId: "instance-a", now: Date.now() });
    assert.equal(result.written, false);
    assert.equal(fs.existsSync(paths.connected), false, "instance A's write must be refused outright, not silently succeed");
  });
  test("refuses when .pid.json is missing entirely (the holder already shut down)", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    const result = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId: "instance-a", now: Date.now() });
    assert.equal(result.written, false);
  });
  test("both interleavings of a plan_connect start() racing the previous child's ready write lose neither field", () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    // Interleaving 1: the OLD instance's ready-write (writeConnectedIfCurrent)
    // arrives BEFORE the new plan_connect start() replaces .pid.json — a
    // perfectly ordinary, un-raced write. It must succeed.
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: 1, sessionId: SESSION, heartbeatAt: new Date().toISOString(), instanceId: "instance-old" }));
    const first = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId: "instance-old", now: Date.now() });
    assert.equal(first.written, true);
    // Interleaving 2: NOW the race — a plan_connect start() mints a fresh
    // instance and overwrites .pid.json (simulating the .lock having already
    // been released) BEFORE the old instance's write arrives.
    fs.writeFileSync(paths.pid, JSON.stringify({ pid: 2, sessionId: SESSION, heartbeatAt: new Date().toISOString(), instanceId: "instance-new" }));
    fs.writeFileSync(paths.started, JSON.stringify(started({ lastStartedInstance: "instance-new" })));
    const stale = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId: "instance-old", now: Date.now() });
    assert.equal(stale.written, false, "the superseded (old) instance's write must be refused");
    // lastStartedInstance survives untouched — single-writer, never raced.
    assert.equal(state.readJsonFile(paths.started).lastStartedInstance, "instance-new");
    // The new instance's own (later) write still succeeds normally.
    const fresh = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId: "instance-new", now: Date.now() });
    assert.equal(fresh.written, true);
  });
});

describe("start() writes .started.json (DX-2953)", () => {
  test("a start that returns early (lock held) never writes .started.json", async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(pathsFor(dataDir).lock, "");
    await bridge.start({ env: env(dataDir), sessionId: SESSION, spawnRun: () => ({ pid: 1 }), stderr: () => {}, waitVerdict: noVerdict });
    assert.equal(fs.existsSync(pathsFor(dataDir).started), false);
  });
  test("a start that returns early (fresh holder, non-connect intent) never writes or overwrites .started.json", async () => {
    const dataDir = tmpDir();
    writePid(dataDir, { pid: process.pid, sessionId: SESSION, heartbeatAt: new Date().toISOString(), instanceId: "instance-already-there" });
    fs.writeFileSync(pathsFor(dataDir).started, JSON.stringify(started({ lastStartedInstance: "instance-already-there" })));
    const result = await bridge.start({ env: env(dataDir), sessionId: SESSION, intent: "resume", spawnRun: () => ({ pid: 999 }), isAlive: () => true, stderr: () => {}, waitVerdict: noVerdict });
    assert.equal(result.started, false);
    assert.equal(state.readJsonFile(pathsFor(dataDir).started).lastStartedInstance, "instance-already-there", "lastStartedInstance must not be overwritten by a start that never actually spawned");
  });
  test("a successful start writes .started.json with a fresh, non-watchdog record (generation 0)", async () => {
    const dataDir = tmpDir();
    const result = await bridge.start({ env: env(dataDir), sessionId: SESSION, intent: "connect", transcriptPath: "/x/transcript.jsonl", spawnRun: () => ({ pid: 4242 }), stderr: () => {}, waitVerdict: noVerdict });
    assert.equal(result.started, true);
    const rec = state.readJsonFile(pathsFor(dataDir).started);
    assert.equal(rec.lastStartedInstance, state.readJsonFile(pathsFor(dataDir).pid).instanceId);
    assert.equal(rec.restartGeneration, 0);
    assert.equal(rec.consumedStopInstance, null);
    assert.equal(rec.startInputs.transcriptPath, "/x/transcript.jsonl");
    assert.equal(rec.startInputs.intent, "connect");
  });
  test("a spawnRun throw writes .started.json for the attempted instance AND a bridge_failed stop record, then returns started:false", async () => {
    const dataDir = tmpDir();
    const result = await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      spawnRun: () => {
        throw new Error("ENOENT: spawn failed");
      },
      stderr: () => {},
      waitVerdict: noVerdict,
    });
    assert.equal(result.started, false);
    assert.match(result.reason, /ENOENT/);
    assert.equal(result.exitCode, 2);
    const paths = pathsFor(dataDir);
    assert.equal(fs.existsSync(paths.pid), false, "no child, so no pid record");
    const startedRec = state.readJsonFile(paths.started);
    assert.equal(typeof startedRec.lastStartedInstance, "string");
    assert.ok(startedRec.lastStartedInstance.length > 0);
    const stoppedRec = state.readJsonFile(paths.stopped);
    assert.equal(stoppedRec.reason, "bridge_failed");
    assert.match(stoppedRec.detail, /ENOENT/);
    assert.equal(stoppedRec.writingInstanceId, startedRec.lastStartedInstance);
  });
  test("a watchdog-triggered start bumps restartGeneration and records the consumed instance", async () => {
    const dataDir = tmpDir();
    await bridge.start({
      env: env(dataDir),
      sessionId: SESSION,
      intent: "resume",
      restartTrigger: "watchdog",
      consumeStopInstance: "the-failed-instance",
      spawnRun: () => ({ pid: 111 }),
      stderr: () => {},
      waitVerdict: noVerdict,
    });
    const rec = state.readJsonFile(pathsFor(dataDir).started);
    assert.equal(rec.restartGeneration, 1);
    assert.equal(rec.consumedStopInstance, "the-failed-instance");
  });
});

describe("hookMayStart — a hook spawns nothing for a session with no plan connection record (DX-3392 1762/1764, DX-4391)", () => {
  test("a hook follows the connection record, read under DANXBOT_PLAN_SESSIONS_HOME", () => {
    const seen = [];
    const connected = (sessionId, home) => {
      seen.push([sessionId, home]);
      return sessionId === "on-a-plan";
    };
    const env = { DANXBOT_PLAN_SESSIONS_HOME: "/fake-home" };
    assert.equal(bridge.hookMayStart({ sessionId: "on-a-plan", env, connected }), true);
    assert.equal(bridge.hookMayStart({ sessionId: "no-plan", env, connected }), false);
    assert.deepEqual(seen, [["on-a-plan", "/fake-home"], ["no-plan", "/fake-home"]]);
  });

  test("a sign-in answer starts nothing even when an old record is there; a connection envelope follows the record", () => {
    const connected = () => true;
    const answer = (state) => JSON.stringify({ state, approvalUrl: "https://dash.example/connect/x", confirmCode: "ABCD1234" });
    for (const state of ["approval_required", "approval_pending", "signed_in", "denied"]) {
      assert.equal(bridge.hookMayStart({ sessionId: SESSION, toolResultText: answer(state), env: {}, connected }), false, state);
    }
    const envelope = JSON.stringify({ ok: true, status: 200, body: { session: { plan_id: 2 } } });
    assert.equal(bridge.hookMayStart({ sessionId: SESSION, toolResultText: envelope, env: {}, connected }), true);
    assert.equal(bridge.hookMayStart({ sessionId: SESSION, toolResultText: "", env: {}, connected }), true);
    assert.equal(bridge.hookMayStart({ sessionId: SESSION, toolResultText: "not json", env: {}, connected: () => false }), false);
  });

  test("the real record decides: absent → no start, present → start", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-gate-"));
    try {
      const env = { DANXBOT_PLAN_SESSIONS_HOME: home };
      assert.equal(bridge.hookMayStart({ sessionId: SESSION, env }), false);
      const dir = path.join(home, ".config", "danxbot", "plan-sessions");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${SESSION}.json`), "{}");
      assert.equal(bridge.hookMayStart({ sessionId: SESSION, env }), true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a PostToolUse payload's tool answer (DX-4391)", () => {
  const text = '{"state":"signed_in"}';
  test("toolResponseText reads a string, content blocks, or an object holding them; anything else is empty", () => {
    assert.equal(toolResponseText(text), text);
    assert.equal(toolResponseText([{ type: "text", text }, { type: "image" }]), text);
    assert.equal(toolResponseText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
    for (const odd of [undefined, null, 7, {}, { content: "x" }, [null]]) assert.equal(toolResponseText(odd), "");
  });

  test("parseHookPayload carries it; a payload without one reads empty", () => {
    assert.equal(parseHookPayload(JSON.stringify({ session_id: SESSION, tool_response: text }), {}).toolResultText, text);
    assert.equal(parseHookPayload(JSON.stringify({ session_id: SESSION }), {}).toolResultText, "");
    assert.equal(parseHookPayload("not json", {}).toolResultText, "");
  });
});

describe("start mode's watchdog flags (DX-3997)", () => {
  test("no flags is a plain hook start", () => {
    assert.deepEqual(bridge.parseStartFlags([]), { restartTrigger: undefined, consumeStopInstance: null });
  });

  test("--restart-trigger=watchdog with and without the stop instance to consume", () => {
    assert.deepEqual(bridge.parseStartFlags(["--restart-trigger=watchdog"]), { restartTrigger: "watchdog", consumeStopInstance: null });
    assert.deepEqual(bridge.parseStartFlags(["--restart-trigger=watchdog", "--consume-stop-instance=inst-1"]), {
      restartTrigger: "watchdog",
      consumeStopInstance: "inst-1",
    });
  });

  test("anything else fails loud instead of starting as a plain connect", () => {
    assert.throws(() => bridge.parseStartFlags(["--restart-trigger=cron"]), /only accepts watchdog/);
    assert.throws(() => bridge.parseStartFlags(["--consume-stop-instance=inst-1"]), /needs --restart-trigger=watchdog/);
    assert.throws(() => bridge.parseStartFlags(["--restart-trigger="]), /unknown start argument/);
    assert.throws(() => bridge.parseStartFlags(["--bogus"]), /unknown start argument/);
  });

  test("a watchdog start is always the resume intent and skips the plan-connection gate, whatever hook event carried it", () => {
    // DX-4321: it also never refreshes the recorded MCP version (that is a session start's job), even when the payload says SessionStart.
    const hook = { sessionId: SESSION, intent: bridge.CONNECT_INTENT, transcriptPath: "/t.jsonl", sessionStart: true };
    const request = bridge.resolveStartRequest({ hook, flags: { restartTrigger: "watchdog", consumeStopInstance: "inst-1" } });
    assert.deepEqual(request, {
      sessionId: SESSION,
      intent: bridge.RESUME_INTENT,
      transcriptPath: "/t.jsonl",
      sessionStart: false,
      restartTrigger: "watchdog",
      consumeStopInstance: "inst-1",
      gated: false,
    });
  });

  test("a hook start refreshes the recorded version only for a SessionStart payload (DX-4321)", () => {
    const flags = bridge.parseStartFlags([]);
    assert.equal(bridge.resolveStartRequest({ hook: { sessionId: SESSION, intent: bridge.RESUME_INTENT, transcriptPath: null, sessionStart: true }, flags }).sessionStart, true);
    assert.equal(bridge.resolveStartRequest({ hook: { sessionId: SESSION, intent: bridge.CONNECT_INTENT, transcriptPath: null, sessionStart: false }, flags }).sessionStart, false);
  });

  test("a hook start keeps the hook's own intent and stays gated", () => {
    const hook = { sessionId: SESSION, intent: bridge.CONNECT_INTENT, transcriptPath: null };
    const request = bridge.resolveStartRequest({ hook, flags: bridge.parseStartFlags([]) });
    assert.equal(request.intent, bridge.CONNECT_INTENT);
    assert.equal(request.gated, true);
    assert.equal(request.restartTrigger, undefined);
  });

  test("the watchdog mode is gone from the bridge's CLI", () => {
    const result = spawnSync(process.execPath, [path.join(here, "..", "scripts", "plan-event-bridge.mjs"), "watchdog"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: plan-event-bridge\.mjs start\|stop\|run/);
  });

  // DX-4391: the real CLI, as the PostToolUse(plan_connect) hook runs it. The env lacks the messaging inbox on purpose:
  // a start that got past the gate would announce that on stderr and exit 2, so a quiet exit 0 proves nothing started.
  describe("the PostToolUse(plan_connect) hook run for real", () => {
    const runHook = (home, toolResponse) =>
      spawnSync(process.execPath, [path.join(here, "..", "scripts", "plan-event-bridge.mjs"), "start"], {
        encoding: "utf8",
        input: JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "mcp__danx-dashboard__plan_connect", tool_response: toolResponse }),
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DANXBOT_PLAN_SESSIONS_HOME: home },
      });

    test("a plan_connect that left no connection record (approval_required, approval_pending, signed_in) starts nothing and says nothing", () => {
      const home = tmpDir();
      try {
        const result = runHook(home);
        assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("a sign-in answer over a stale record (key lapsed, record kept) starts nothing and says nothing, whichever shape tool_response has", () => {
      const home = tmpDir();
      try {
        const dir = path.join(home, ".config", "danxbot", "plan-sessions");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${SESSION}.json`), "{}");
        const text = JSON.stringify({ state: "approval_required", approvalUrl: "https://dash.example/connect/x", confirmCode: "ABCD1234" });
        const blocks = [{ type: "text", text }];
        for (const toolResponse of [text, blocks, { content: blocks }]) {
          const result = runHook(home, toolResponse);
          assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], JSON.stringify(toolResponse).slice(0, 40));
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("a plan_connect that left the connection record starts the bridge (here it fails loud on the missing inbox)", () => {
      const home = tmpDir();
      try {
        const dir = path.join(home, ".config", "danxbot", "plan-sessions");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${SESSION}.json`), "{}");
        const result = runHook(home, JSON.stringify({ ok: true, status: 200, body: { session: { plan_id: 2 } } }));
        assert.equal(result.status, 2);
        assert.match(result.stderr, /could not start/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
