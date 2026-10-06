// danxbot plan event bridge watchdog (DX-2953; moved out of the bridge by DX-3997) — the
// restart decision, the throttle, the tick orchestration, the subprocess hand-off to the
// bridge's `start`, and the guarantee that none of it depends on plan-event-bridge.mjs.
// Run with `node --test` (no dependencies).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as bridge from "../scripts/plan-event-bridge.mjs";
import * as state from "../scripts/lib/bridge-state.mjs";
import * as decision from "../scripts/lib/bridge-restart-decision.mjs";
import * as watchdog from "../scripts/bridge-watchdog.mjs";
import { spawnStandIn } from "./fixtures/spawn-standin.mjs";
import { TEST_VERSION, recordVersion } from "./fixtures/fake-dashboard-mcp.mjs";
import { REGISTRY_BASE_URL_ENV } from "./fixtures/fake-registry.mjs";
import { SESSION, started, stopped, NOW, freshPid, stalePid, connectedTrue, connectedFalse } from "./fixtures/bridge-records.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, "..", "scripts");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bwd-test-"));
}

// DX-4321: a watchdog restart runs the bridge's `start`, which needs a RECORDED danx-dashboard-mcp version, so
// every env built here has one recorded under `dataDir`; the registry URL points at a port nothing listens on, so
// a start that wrongly reached for the registry would fail instead of reaching npm.
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

function pathsFor(dataDir) {
  return state.sessionPaths(state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir }), SESSION);
}

const noVerdict = async () => null;
const HOOK_TEXT = JSON.stringify({ session_id: SESSION, hook_event_name: "Stop", transcript_path: "/t/transcript.jsonl" });

// ======================================================= the pure restart decision

describe("isMarkerStale (DX-2953)", () => {
  test("missing pid record is stale", () => {
    assert.equal(decision.isMarkerStale({ pidRecord: null, now: NOW }), true);
  });
  test("fresh heartbeat is not stale", () => {
    assert.equal(decision.isMarkerStale({ pidRecord: freshPid, now: NOW }), false);
  });
  test("heartbeat older than heartbeatStaleMs is stale", () => {
    assert.equal(decision.isMarkerStale({ pidRecord: stalePid, now: NOW }), true);
  });
  test("an unparsable heartbeatAt is stale", () => {
    assert.equal(decision.isMarkerStale({ pidRecord: { ...freshPid, heartbeatAt: "not-a-date" }, now: NOW }), true);
  });
});

describe("effectiveRestartGeneration (DX-2953)", () => {
  test("stored 0 stays 0 regardless of timing", () => {
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: started({ restartGeneration: 0 }), stoppedRecord: null, now: NOW }), 0);
  });
  test("no startedRecord at all reads as 0", () => {
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: null, stoppedRecord: null, now: NOW }), 0);
  });
  test("stored generation > 0, ran less than HEALTHY_RUN_MS (no applicable stop record, still running): stays elevated", () => {
    const s = started({ restartGeneration: 1, startedAt: new Date(NOW - 5_000).toISOString() });
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: s, stoppedRecord: null, now: NOW }), 1);
  });
  test("stored generation > 0, ran at least HEALTHY_RUN_MS (still alive, measured against now): resets to 0", () => {
    const s = started({ restartGeneration: 1, startedAt: new Date(NOW - state.HEALTHY_RUN_MS - 5_000).toISOString() });
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: s, stoppedRecord: null, now: NOW }), 0);
  });
  test("stored generation > 0, an APPLICABLE stop record recorded before HEALTHY_RUN_MS elapsed: stays elevated (quick death)", () => {
    const startedAt = NOW - 10_000;
    const s = started({ restartGeneration: 1, lastStartedInstance: "instance-b", startedAt: new Date(startedAt).toISOString() });
    const rec = stopped("bridge_failed", { writingInstanceId: "instance-b", recordedAt: new Date(startedAt + 2_000).toISOString() });
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: s, stoppedRecord: rec, now: NOW }), 1);
  });
  test("stored generation > 0, an APPLICABLE stop record recorded AFTER HEALTHY_RUN_MS: resets to 0 (ran healthy first)", () => {
    const startedAt = NOW - state.HEALTHY_RUN_MS - 100_000;
    const s = started({ restartGeneration: 1, lastStartedInstance: "instance-b", startedAt: new Date(startedAt).toISOString() });
    const rec = stopped("bridge_failed", { writingInstanceId: "instance-b", recordedAt: new Date(startedAt + state.HEALTHY_RUN_MS + 5_000).toISOString() });
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: s, stoppedRecord: rec, now: NOW }), 0);
  });
  test("a stop record from a DIFFERENT (superseded) instance is not applicable — measured against now instead", () => {
    const s = started({ restartGeneration: 1, lastStartedInstance: "instance-b", startedAt: new Date(NOW - state.HEALTHY_RUN_MS - 5_000).toISOString() });
    const rec = stopped("bridge_failed", { writingInstanceId: "instance-OLD", recordedAt: new Date(NOW - 500_000).toISOString() });
    assert.equal(decision.effectiveRestartGeneration({ startedRecord: s, stoppedRecord: rec, now: NOW }), 0);
  });
});

describe("shouldWatchdogRestart (DX-2953) — the full decision table", () => {
  test("never-connected (no connected record at all) never restarts, whatever else is true", () => {
    const d = decision.shouldWatchdogRestart({ pidRecord: null, startedRecord: started(), connectedRecord: null, stoppedRecord: null, now: NOW });
    assert.equal(d.restart, false);
  });
  test("connected:false never restarts (a not_connected stop already answered the question)", () => {
    const d = decision.shouldWatchdogRestart({ pidRecord: null, startedRecord: started(), connectedRecord: connectedFalse, stoppedRecord: null, now: NOW });
    assert.equal(d.restart, false);
  });
  test("connected:true but the bridge is not stale (fresh heartbeat): never restarts — covers a LIVE degraded bridge", () => {
    const d = decision.shouldWatchdogRestart({ pidRecord: freshPid, startedRecord: started(), connectedRecord: connectedTrue, stoppedRecord: stopped("board_unreadable"), now: NOW });
    assert.equal(d.restart, false);
    assert.match(d.reason, /not stale/);
  });
  test("stale, connected, no applicable stop record at all: restarts (the hard-kill headline case)", () => {
    const d = decision.shouldWatchdogRestart({ pidRecord: stalePid, startedRecord: started(), connectedRecord: connectedTrue, stoppedRecord: null, now: NOW });
    assert.equal(d.restart, true);
  });
  test("stale, connected, an applicable record from a DIFFERENT (superseded) instance: ignored, treated as no-applicable-record — restarts", () => {
    const d = decision.shouldWatchdogRestart({
      pidRecord: stalePid,
      startedRecord: started({ lastStartedInstance: "instance-b" }),
      connectedRecord: connectedTrue,
      stoppedRecord: stopped("not_connected", { writingInstanceId: "instance-OLD" }),
      now: NOW,
    });
    assert.equal(d.restart, true, "a not_connected record from an unrelated, superseded instance must not block a different, current instance");
  });
  for (const reason of ["no_connection_record", "credential_unavailable", "not_connected", "superseded", "replaced", "session_is_worker"]) {
    test(`applicable ${reason} record always forbids a restart`, () => {
      const d = decision.shouldWatchdogRestart({ pidRecord: stalePid, startedRecord: started(), connectedRecord: connectedTrue, stoppedRecord: stopped(reason), now: NOW });
      assert.equal(d.restart, false, `${reason} must forbid a restart`);
      assert.match(d.reason, new RegExp(reason));
    });
  }
  test("an applicable degraded-and-killed reason (e.g. board_unreadable) does NOT forbid — restarts", () => {
    const d = decision.shouldWatchdogRestart({ pidRecord: stalePid, startedRecord: started(), connectedRecord: connectedTrue, stoppedRecord: stopped("board_unreadable", { degraded: true }), now: NOW });
    assert.equal(d.restart, true);
  });
  test("applicable bridge_failed, not yet consumed, generation 0: restarts and names the instance to consume", () => {
    const d = decision.shouldWatchdogRestart({ pidRecord: stalePid, startedRecord: started(), connectedRecord: connectedTrue, stoppedRecord: stopped("bridge_failed"), now: NOW });
    assert.equal(d.restart, true);
    assert.equal(d.consumeStopInstance, "instance-a");
  });
  test("applicable bridge_failed already named by consumedStopInstance: does not restart again", () => {
    const d = decision.shouldWatchdogRestart({
      pidRecord: stalePid,
      startedRecord: started({ consumedStopInstance: "instance-a" }),
      connectedRecord: connectedTrue,
      stoppedRecord: stopped("bridge_failed"),
      now: NOW,
    });
    assert.equal(d.restart, false);
    assert.match(d.reason, /already consumed/);
  });
  test("applicable bridge_failed, unconsumed, but restartGeneration has not reset (a restarted bridge failing again quickly): does not restart", () => {
    const startedAt = NOW - 10_000;
    const d = decision.shouldWatchdogRestart({
      pidRecord: stalePid,
      startedRecord: started({ restartGeneration: 1, startedAt: new Date(startedAt).toISOString() }),
      connectedRecord: connectedTrue,
      stoppedRecord: stopped("bridge_failed", { recordedAt: new Date(startedAt + 2_000).toISOString() }),
      now: NOW,
    });
    assert.equal(d.restart, false);
    assert.match(d.reason, /restartGeneration/);
  });
  test("a plain stale-no-record case is ALSO gated by a non-reset restartGeneration (crash-loop guard applies uniformly)", () => {
    const startedAt = NOW - 10_000;
    const d = decision.shouldWatchdogRestart({
      pidRecord: stalePid,
      startedRecord: started({ restartGeneration: 1, startedAt: new Date(startedAt).toISOString() }),
      connectedRecord: connectedTrue,
      stoppedRecord: null,
      now: NOW,
    });
    assert.equal(d.restart, false);
  });
  test("bridge_failed restarts again once restartGeneration has reset (ran healthy first)", () => {
    const startedAt = NOW - state.HEALTHY_RUN_MS - 100_000;
    const d = decision.shouldWatchdogRestart({
      pidRecord: stalePid,
      startedRecord: started({ restartGeneration: 1, startedAt: new Date(startedAt).toISOString() }),
      connectedRecord: connectedTrue,
      stoppedRecord: stopped("bridge_failed", { recordedAt: new Date(startedAt + state.HEALTHY_RUN_MS + 5_000).toISOString() }),
      now: NOW,
    });
    assert.equal(d.restart, true);
  });
  test("does not read the applicable record's paths field at all (not part of the decision)", () => {
    const rec = stopped("board_unreadable", { paths: ["/should/never/matter.json"] });
    const d = decision.shouldWatchdogRestart({ pidRecord: stalePid, startedRecord: started(), connectedRecord: connectedTrue, stoppedRecord: rec, now: NOW });
    assert.equal(d.restart, true);
    assert.equal(Object.prototype.hasOwnProperty.call(d, "paths"), false);
  });
});

describe(".started.json / .connected.json / the watchdog throttle stamp ride STATE_SUFFIXES (DX-2953)", () => {
  test("pruneStale reaches all three when stale", () => {
    const dataDir = tmpDir();
    const dir = state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir });
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.started, "{}");
    fs.writeFileSync(paths.connected, "{}");
    fs.writeFileSync(paths.watchdog, "{}");
    const old = new Date(Date.now() - bridge.STALE_STATE_MS - 5_000);
    for (const f of [paths.started, paths.connected, paths.watchdog]) fs.utimesSync(f, old, old);
    bridge.pruneStale(dir);
    for (const f of [paths.started, paths.connected, paths.watchdog]) assert.equal(fs.existsSync(f), false, `${f} should have been pruned`);
  });
  test("fresh copies of all three survive pruneStale", () => {
    const dataDir = tmpDir();
    const dir = state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir });
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.started, "{}");
    fs.writeFileSync(paths.connected, "{}");
    fs.writeFileSync(paths.watchdog, "{}");
    bridge.pruneStale(dir);
    for (const f of [paths.started, paths.connected, paths.watchdog]) assert.equal(fs.existsSync(f), true);
  });
});

describe("watchdog — real process lifecycle (DX-2953)", () => {
  const fixturePath = path.join(here, "fixtures", "run-bridge.mjs");
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
  function killIfAlive(target, { tree = false } = {}) {
    if (typeof target === "number") {
      if (bridge.isAlive(target)) bridge.killTree(target);
      return;
    }
    if (target.exitCode !== null || target.signalCode !== null) return;
    if (tree) bridge.killTree(target.pid);
    else target.kill();
  }
  /** A real CLAUDE_PID stand-in the fixture's run() process supervises. */
  async function spawnStandInTracked() {
    const standIn = track(spawnStandIn());
    await onceWithTimeout(standIn, "spawn", 5_000, "stand-in spawn");
    return standIn;
  }
  function spawnFixture({ dataDir, sessionId = SESSION, intent = "resume", claudePid, inboxAddress, scriptedRecords, scriptedExitCode, instanceId = "watchdog-test-instance" }) {
    const fixtureEnv = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CODE_MESSAGING_SOCKET: inboxAddress,
      CLAUDE_CODE_MESSAGING_TOKEN: "inbox-secret",
      RUN_BRIDGE_FIXTURE_CONFIG: JSON.stringify({ sessionId, intent, parentCheckMs: 250, scriptedRecords, scriptedExitCode }),
    };
    if (claudePid === undefined) delete fixtureEnv.CLAUDE_PID;
    else fixtureEnv.CLAUDE_PID = String(claudePid);
    // NOTE: a destructured default only applies on `undefined`, so pass
    // `instanceId: null` (never `undefined`) to omit it.
    if (instanceId === null) delete fixtureEnv.DANX_BRIDGE_INSTANCE_ID;
    else fixtureEnv.DANX_BRIDGE_INSTANCE_ID = instanceId;
    return track(spawn(process.execPath, [fixturePath], { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] }));
  }
  async function waitForBridgeStarted(dataDir) {
    const paths = pathsFor(dataDir);
    assert.ok(
      await waitFor(() => {
        try {
          return /bridge started for session/.test(fs.readFileSync(paths.log, "utf8"));
        } catch {
          return false;
        }
      }, { timeoutMs: 10_000 }),
      "bridge never logged 'bridge started'",
    );
    return paths;
  }
  async function inboxServer() {
    const address =
      process.platform === "win32"
        ? `\\\\.\\pipe\\peb-watchdog-fixture-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
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
    let closed = false;
    const close = () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        server.close(resolve);
      });
    return { address, received, close };
  }
  /** Directly ages `.pid.json`'s heartbeat so the watchdog sees a genuinely dead
   * (hard-killed) process as stale without a real ~90s wait — the process was
   * really spawned, really reached the state under test, and was really killed;
   * only the STALENESS CLOCK is fast-forwarded, the same technique this file
   * already uses for "a lock left by a crashed start is taken over once it is
   * stale". */
  function ageHeartbeat(paths) {
    const record = state.readJsonFile(paths.pid);
    record.heartbeatAt = new Date(Date.now() - state.HEARTBEAT_STALE_MS - 5_000).toISOString();
    fs.writeFileSync(paths.pid, JSON.stringify(record));
  }

  const standInStartScript = path.join(here, "fixtures", "watchdog-start-standin.mjs");
  /** The real watchdog, which runs the stand-in `start` (real start() logic, stubbed final spawn) as a real subprocess. */
  async function fireWatchdog({ dataDir, address }) {
    const spawnLog = path.join(dataDir, "spawned-runs.log");
    const result = await watchdog.watchdogTick({
      env: { ...process.env, ...env(dataDir, { CLAUDE_CODE_MESSAGING_SOCKET: address }), STANDIN_SPAWN_LOG: spawnLog },
      sessionId: SESSION,
      hookText: HOOK_TEXT,
      bridgeScript: standInStartScript,
    });
    const spawned = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length : 0;
    return { result, spawned };
  }

  test("hard-kill a running (connected) bridge, fire the watchdog: exactly one new bridge starts, through start() and its .lock", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = await spawnStandInTracked();
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      inboxAddress: address,
      scriptedRecords: [{ type: "ready", boards: ["b"], cardCount: 1, degraded: false }],
    });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const paths = await waitForBridgeStarted(dataDir);
      assert.ok(await waitFor(() => fs.existsSync(paths.connected)), ".connected.json was never written by the real run() process");
      assert.equal(state.readJsonFile(paths.connected).connected, true);
      const firstInstance = state.readJsonFile(paths.pid).instanceId;

      // Hard-kill the real bridge process — no graceful shutdown, so .pid.json
      // is left behind with a now-frozen heartbeat (see ageHeartbeat above).
      killIfAlive(fixture, { tree: true });
      await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      ageHeartbeat(paths);

      const { result, spawned } = await fireWatchdog({ dataDir, address });

      assert.equal(result.ticked, true);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.restartAttempted, true, `expected a restart; reason was: ${result.reason}`);
      assert.equal(spawned, 1, "exactly one new bridge must start");
      const secondInstance = state.readJsonFile(paths.pid).instanceId;
      assert.notEqual(secondInstance, firstInstance, "the watchdog restart must mint a genuinely new instance");
      const startedRecord = state.readJsonFile(paths.started);
      assert.equal(startedRecord.lastStartedInstance, secondInstance);
      // What the subprocess carried: the watchdog trigger (generation bumped), the resume intent
      // even though the hook that ran the watchdog was a Stop/PostToolUse one, and the transcript path.
      assert.equal(startedRecord.restartGeneration, 1);
      assert.equal(startedRecord.startInputs.intent, bridge.RESUME_INTENT);
      assert.equal(startedRecord.startInputs.transcriptPath, "/t/transcript.jsonl");
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("a never-connected session (no .connected.json ever written) spawns nothing, ever, even after a hard kill", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = await spawnStandInTracked();
    // No scriptedRecords: the stub subcommand never emits "ready", so onReady
    // never fires and .connected.json is never created — a real, never-connected
    // session, exactly as if the operator never called plan_connect.
    const fixture = spawnFixture({ dataDir, claudePid: standIn.pid, inboxAddress: address });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const paths = await waitForBridgeStarted(dataDir);
      assert.equal(fs.existsSync(paths.connected), false, "connected marker must not exist — this session never reached ready");
      killIfAlive(fixture, { tree: true });
      await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      ageHeartbeat(paths);

      const { result, spawned } = await fireWatchdog({ dataDir, address });
      assert.equal(result.restartAttempted, false);
      assert.equal(spawned, 0, "a never-connected session must never spawn a bridge, whatever the watchdog observes");
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("a live degraded bridge (fresh heartbeat) is never restarted, whatever its stop record says", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = await spawnStandInTracked();
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      inboxAddress: address,
      // ready, then a DEGRADED stop record (the child stays alive, heartbeating,
      // per DX-3028) — the subcommand stand-in never exits (no scriptedExitCode).
      scriptedRecords: [
        { type: "ready", boards: ["b"], cardCount: 1, degraded: false },
        { type: "stopped", reason: "board_unreadable", detail: "cannot read board", fix: "", paths: [], instanceId: "", degraded: true },
      ],
    });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const paths = await waitForBridgeStarted(dataDir);
      assert.ok(await waitFor(() => fs.existsSync(paths.stopped)), "the degraded stop record was never persisted");
      assert.equal(state.readJsonFile(paths.stopped).reason, "board_unreadable");
      assert.equal(state.readJsonFile(paths.connected).connected, true, "a degraded-but-bound session still records connected:true");
      // NOT killed — the fixture's run() process is still alive and heartbeating.

      const { result, spawned } = await fireWatchdog({ dataDir, address });
      assert.equal(result.restartAttempted, false);
      assert.match(result.reason, /not stale/);
      assert.equal(spawned, 0);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("a bridge that degraded, recovered to streaming (a real event arrives), then was hard-killed IS restarted", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = await spawnStandInTracked();
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      inboxAddress: address,
      scriptedRecords: [
        { type: "ready", boards: ["b"], cardCount: 1, degraded: false },
        { type: "stopped", reason: "board_unreadable", detail: "cannot read board", fix: "", paths: [], instanceId: "", degraded: true },
        // Recovery: a real relayed event proves the child is streaming again —
        // this must delete the (now-stale) degraded stop record above.
        { type: "event", id: 1, text: "recovered event" },
      ],
    });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const paths = await waitForBridgeStarted(dataDir);
      assert.ok(await waitFor(() => fs.existsSync(paths.stopped)), "the degraded stop record was never persisted");
      assert.ok(
        await waitFor(() => !fs.existsSync(paths.stopped)),
        "the stop record must be deleted once the recovery event arrives",
      );
      const instanceBefore = state.readJsonFile(paths.pid).instanceId;

      killIfAlive(fixture, { tree: true });
      await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      ageHeartbeat(paths);

      const { result, spawned } = await fireWatchdog({ dataDir, address });
      assert.equal(result.restartAttempted, true, `expected a restart; reason was: ${result.reason}`);
      assert.equal(spawned, 1);
      assert.notEqual(state.readJsonFile(paths.pid).instanceId, instanceBefore);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("run()'s own CLAUDE_PID-missing fatal refusal persists a bridge_failed stop record naming its instance", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    // intent "connect" so isSessionKnownToWantEvents is true regardless of cursor state.
    const fixture = spawnFixture({ dataDir, claudePid: undefined, intent: "connect", inboxAddress: address, instanceId: "no-claude-pid-instance" });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 1, "a missing CLAUDE_PID must exit non-zero");
      const paths = pathsFor(dataDir);
      assert.ok(await waitFor(() => fs.existsSync(paths.stopped)), "no bridge_failed record was persisted for the CLAUDE_PID-missing refusal");
      const rec = state.readJsonFile(paths.stopped);
      assert.equal(rec.reason, "bridge_failed");
      assert.equal(rec.writingInstanceId, "no-claude-pid-instance");
      assert.match(rec.detail, /CLAUDE_PID/);
    } finally {
      killIfAlive(fixture, { tree: true });
      await close();
    }
  });

  test("run() refuses loudly (never silently mints a fresh id) when DANX_BRIDGE_INSTANCE_ID is absent from its own environment", async () => {
    const dataDir = tmpDir();
    const { received, address, close } = await inboxServer();
    const standIn = await spawnStandInTracked();
    const fixture = spawnFixture({ dataDir, claudePid: standIn.pid, intent: "connect", inboxAddress: address, instanceId: null });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const [code] = await onceWithTimeout(fixture, "exit", 8_000, "fixture exit");
      assert.equal(code, 1, "a missing DANX_BRIDGE_INSTANCE_ID must exit non-zero, never a silent randomUUID() fallback");
      assert.ok(await waitFor(() => received.some((frame) => frame.type === "user")), "no notice reached the session's inbox");
      const notice = received.find((frame) => frame.type === "user");
      assert.match(notice.message.content, /DANX_BRIDGE_INSTANCE_ID/);
      // No pid record either — the refusal happens before this instance could ever claim the session.
      assert.equal(fs.existsSync(pathsFor(dataDir).pid), false);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });

  test("cross-repo instance-id drift: a stop record's own instanceId differing from writingInstanceId is logged", async () => {
    const dataDir = tmpDir();
    const { address, close } = await inboxServer();
    const standIn = await spawnStandInTracked();
    const fixture = spawnFixture({
      dataDir,
      claudePid: standIn.pid,
      inboxAddress: address,
      instanceId: "run-process-instance",
      scriptedRecords: [
        { type: "ready", boards: ["b"], cardCount: 1, degraded: false },
        // The MCP child's OWN instanceId (bridge.ts's resolveInstanceId) has
        // drifted from what this run process was actually spawned with.
        { type: "stopped", reason: "revoked", detail: "d", fix: "", paths: [], instanceId: "drifted-child-instance", degraded: true },
      ],
    });
    fixture.stdout.resume();
    fixture.stderr.resume();
    try {
      const paths = await waitForBridgeStarted(dataDir);
      assert.ok(await waitFor(() => fs.existsSync(paths.stopped)));
      assert.ok(
        await waitFor(() => /instance id drift/.test(fs.readFileSync(paths.log, "utf8"))),
        "no drift message was logged",
      );
      const logText = fs.readFileSync(paths.log, "utf8");
      assert.match(logText, /drifted-child-instance/);
      assert.match(logText, /run-process-instance/);
    } finally {
      killIfAlive(fixture, { tree: true });
      killIfAlive(standIn);
      await close();
    }
  });
});


// ===================================== the tick: throttle, liveness, orchestration, hand-off


const ok = { code: 0, signal: null, stdout: "", stderr: "", spawnError: null };
/** A `runStart` that records every call and answers with `outcome`. */
function recordingRunStart(calls, outcome = ok) {
  return async (request) => {
    calls.push(request);
    return outcome;
  };
}
const neverRunStart = async () => assert.fail("the watchdog must not run the bridge's start here");

describe("watchdogTick — throttle, marker liveness, orchestration (DX-2953)", () => {
  test("with no CLAUDE_PLUGIN_DATA or session id, no-ops without touching disk", async () => {
    const quiet = { ticked: false, restartAttempted: false, exitCode: 0, stdout: "", stderr: "" };
    assert.deepEqual(await watchdog.watchdogTick({ env: {}, sessionId: SESSION, runStart: neverRunStart }), quiet);
    assert.deepEqual(await watchdog.watchdogTick({ env: env(tmpDir()), sessionId: "", runStart: neverRunStart }), quiet);
  });

  test("the first-ever tick (no throttle stamp yet) runs; a second tick inside throttleMs is a no-op that spawns nothing", async () => {
    const dataDir = tmpDir();
    // Not connected, so the decision is "no restart" either way — this test is
    // purely about the THROTTLE gating a second tick, not the decision.
    const tick = (nowMs) => watchdog.watchdogTick({ env: env(dataDir), sessionId: SESSION, runStart: neverRunStart, throttleMs: 60_000, now: () => nowMs });
    assert.equal((await tick(1_000_000)).ticked, true);
    assert.equal((await tick(1_010_000)).ticked, false, "a tick inside the throttle window must be a pure no-op");
    assert.equal((await tick(1_070_000)).ticked, true, "a tick past the throttle window must run again");
  });

  test("the healthy path (not stale) does file stats only: no subprocess, no output", async () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.pid, JSON.stringify(freshPid));
    fs.writeFileSync(paths.started, JSON.stringify(started()));
    fs.writeFileSync(paths.connected, JSON.stringify(connectedTrue));
    const result = await watchdog.watchdogTick({ env: env(dataDir), sessionId: SESSION, hookText: HOOK_TEXT, runStart: neverRunStart, now: () => NOW + 1 });
    assert.equal(result.ticked, true);
    assert.equal(result.restartAttempted, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test("a restart-eligible tick runs the bridge's start with the watchdog trigger, the consumed stop instance and the hook payload on stdin", async () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.pid, JSON.stringify(stalePid));
    fs.writeFileSync(paths.started, JSON.stringify(started()));
    fs.writeFileSync(paths.connected, JSON.stringify(connectedTrue));
    fs.writeFileSync(paths.stopped, JSON.stringify(stopped("bridge_failed")));
    const calls = [];
    const runEnv = env(dataDir);
    const result = await watchdog.watchdogTick({ env: runEnv, sessionId: SESSION, hookText: HOOK_TEXT, bridgeScript: "/the/bridge.mjs", runStart: recordingRunStart(calls), now: () => NOW });
    assert.equal(result.restartAttempted, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, [
      { bridgeScript: "/the/bridge.mjs", args: ["start", "--restart-trigger=watchdog", "--consume-stop-instance=instance-a"], input: HOOK_TEXT, env: runEnv },
    ]);
    // the flags the watchdog builds are exactly what the bridge's own parser accepts
    assert.deepEqual(bridge.parseStartFlags(calls[0].args.slice(1)), { restartTrigger: "watchdog", consumeStopInstance: "instance-a" });
  });

  test("a stale bridge with no stop record to consume is restarted without --consume-stop-instance", async () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.pid, JSON.stringify(stalePid));
    fs.writeFileSync(paths.started, JSON.stringify(started()));
    fs.writeFileSync(paths.connected, JSON.stringify(connectedTrue));
    const calls = [];
    await watchdog.watchdogTick({ env: env(dataDir), sessionId: SESSION, hookText: HOOK_TEXT, runStart: recordingRunStart(calls), now: () => NOW });
    assert.deepEqual(calls[0].args, ["start", "--restart-trigger=watchdog"]);
  });

  test("the subprocess's own deliberate exit 2 passes its stdout and stderr straight through", async () => {
    const dataDir = tmpDir();
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.pid, JSON.stringify(stalePid));
    fs.writeFileSync(paths.connected, JSON.stringify(connectedTrue));
    const notice = "[danxbot plan event] bridge down: events are NOT reaching this session: x. Fix: y.\n";
    const result = await watchdog.watchdogTick({
      env: env(dataDir),
      sessionId: SESSION,
      runStart: recordingRunStart([], { code: 2, signal: null, stdout: "out", stderr: notice, spawnError: null }),
      now: () => NOW,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, notice);
    assert.equal(result.stdout, "out");
  });

  test("prune liveness, direction 1: one tick refreshes both marker mtimes past STALE_STATE_MS so a following pruneStale keeps them", async () => {
    const dataDir = tmpDir();
    const dir = state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir });
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.connected, JSON.stringify(connectedFalse)); // not connected -> decision is trivially "no restart"
    fs.writeFileSync(paths.started, JSON.stringify(started()));
    const old = new Date(Date.now() - bridge.STALE_STATE_MS - 5_000);
    fs.utimesSync(paths.started, old, old);
    fs.utimesSync(paths.connected, old, old);
    await watchdog.watchdogTick({ env: env(dataDir), sessionId: SESSION, runStart: neverRunStart, now: () => Date.now() });
    bridge.pruneStale(dir);
    assert.equal(fs.existsSync(paths.started), true, ".started.json must survive — the watchdog tick just refreshed its mtime");
    assert.equal(fs.existsSync(paths.connected), true, ".connected.json must survive — the watchdog tick just refreshed its mtime");
  });

  test("prune liveness, direction 2: with NO tick over the window, pruneStale removes both, and a following start()/ready rewrites them with no restart lost", async () => {
    const dataDir = tmpDir();
    const dir = state.stateDir({ CLAUDE_PLUGIN_DATA: dataDir });
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.started, JSON.stringify(started()));
    fs.writeFileSync(paths.connected, JSON.stringify(connectedTrue));
    const old = new Date(Date.now() - bridge.STALE_STATE_MS - 5_000);
    fs.utimesSync(paths.started, old, old);
    fs.utimesSync(paths.connected, old, old);
    bridge.pruneStale(dir); // no watchdog tick ran in between — both should be reclaimed
    assert.equal(fs.existsSync(paths.started), false);
    assert.equal(fs.existsSync(paths.connected), false);
    // A following start() rewrites .started.json regardless of the prune...
    const result = await bridge.start({ env: env(dataDir), sessionId: SESSION, intent: "connect", spawnRun: () => ({ pid: 55 }), stderr: () => {}, waitVerdict: noVerdict });
    assert.equal(result.started, true);
    assert.equal(fs.existsSync(paths.started), true);
    // ...and the new bridge itself would rewrite .connected.json at ready — simulated
    // here via the same fenced writer `run()` uses, proving nothing about the prune
    // stops a subsequent legitimate write from succeeding.
    const instanceId = state.readJsonFile(paths.pid).instanceId;
    const written = bridge.writeConnectedIfCurrent(paths, { connected: true, instanceId, now: Date.now() });
    assert.equal(written.written, true, "no restart capability was lost by the prune — the new bridge can still record connected:true");
  });
});

// ============================ DX-3997: the bridge file dying must not take the watchdog with it

describe("interpretStartOutcome — a start that cannot even run is never silent (DX-3997)", () => {
  const fix = /claude plugin update danxbot.*restart the session/;

  test("0 and the subprocess's deliberate 2 pass through untouched", () => {
    assert.deepEqual(watchdog.interpretStartOutcome({ code: 0, stdout: "a", stderr: "b" }), { exitCode: 0, stdout: "a", stderr: "b" });
    assert.deepEqual(watchdog.interpretStartOutcome({ code: 2, stdout: "", stderr: "notice\n" }), { exitCode: 2, stdout: "", stderr: "notice\n" });
  });

  test("a crash (exit 1, e.g. the script fails to load) becomes exit 2 and ONE loud line naming the script, the code, the stderr tail and the fix", () => {
    const result = watchdog.interpretStartOutcome({ code: 1, signal: null, stdout: "", stderr: "file:///x/plan-event-bridge.mjs:1\nSyntaxError: Invalid or unexpected token\n    at ModuleLoader\n" });
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr.trimEnd().split("\n").length, 1, "one line, so asyncRewake shows it whole");
    assert.match(result.stderr, /^\[danxbot plan event\] bridge down: /);
    assert.match(result.stderr, /`plan-event-bridge\.mjs start` exited 1/);
    assert.match(result.stderr, /SyntaxError: Invalid or unexpected token/);
    assert.match(result.stderr, fix);
  });

  test("a signal kill and a spawn failure are just as loud", () => {
    const killed = watchdog.interpretStartOutcome({ code: null, signal: "SIGKILL", stdout: "", stderr: "" });
    assert.equal(killed.exitCode, 2);
    assert.match(killed.stderr, /was killed by SIGKILL/);
    assert.match(killed.stderr, fix);
    const noSpawn = watchdog.interpretStartOutcome({ code: null, signal: null, stdout: "", stderr: "", spawnError: "spawn ENOENT" });
    assert.equal(noSpawn.exitCode, 2);
    assert.match(noSpawn.stderr, /could not be run \(spawn ENOENT\)/);
  });

  test("quotes the error line, capped, not the whole stack", () => {
    const stderr = ["file:///x/plan-event-bridge.mjs:1", "", "SyntaxError: Invalid or unexpected token " + "z".repeat(5_000), "    at ModuleLoader"].join("\n");
    const result = watchdog.interpretStartOutcome({ code: 1, signal: null, stdout: "", stderr });
    assert.match(result.stderr, /stderr: SyntaxError: Invalid or unexpected token z/);
    assert.doesNotMatch(result.stderr, /ModuleLoader/);
    assert.ok(result.stderr.length < watchdog.STDERR_QUOTE_CHARS + 500);
  });
});

describe("runBridgeStart — a real subprocess (DX-3997)", () => {
  function scriptThatEchoes(dir, exitCode) {
    const file = path.join(dir, "echo-start.mjs");
    fs.writeFileSync(
      file,
      `let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input, plugin: process.env.CLAUDE_PLUGIN_DATA }));
  process.stderr.write("said something");
  process.exit(${exitCode});
});
`,
    );
    return file;
  }

  test("runs the script with the args, the payload on stdin and the env, and returns its code and output", async () => {
    const dir = tmpDir();
    const outcome = await watchdog.runBridgeStart({ bridgeScript: scriptThatEchoes(dir, 2), args: ["start", "--restart-trigger=watchdog"], input: HOOK_TEXT, env: { ...process.env, CLAUDE_PLUGIN_DATA: "/data" } });
    assert.equal(outcome.code, 2);
    assert.equal(outcome.stderr, "said something");
    assert.deepEqual(JSON.parse(outcome.stdout), { argv: ["start", "--restart-trigger=watchdog"], input: HOOK_TEXT, plugin: "/data" });
  });

  test("a script that does not exist is reported as a crash, not thrown", async () => {
    const outcome = await watchdog.runBridgeStart({ bridgeScript: path.join(tmpDir(), "missing.mjs"), args: ["start"], input: "", env: process.env });
    assert.notEqual(outcome.code, 0);
    assert.equal(outcome.spawnError, null);
    assert.equal(watchdog.interpretStartOutcome(outcome).exitCode, 2);
  });
});

describe("the watchdog does not depend on plan-event-bridge.mjs (DX-3997)", () => {
  /** Every module specifier a source file imports, statically or dynamically; a non-literal dynamic import is itself a failure. */
  function importSpecifiers(file) {
    const source = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const specifiers = [];
    for (const match of source.matchAll(/\bimport\s*(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/g)) specifiers.push(match[1]);
    for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)) specifiers.push(match[2]);
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(\s*[^"'`\s]/, `${file} has a non-literal dynamic import — cannot prove what it loads`);
    return specifiers;
  }
  function localClosure(entry) {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of importSpecifiers(file)) {
        if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
      }
    };
    visit(entry);
    return [...seen];
  }

  test("bridge-watchdog.mjs and everything it imports (transitively) never import plan-event-bridge.mjs", () => {
    const closure = localClosure(path.join(scriptsDir, "bridge-watchdog.mjs"));
    assert.ok(closure.length > 4, `expected the watchdog's lib modules in the closure, got ${closure.join(", ")}`);
    for (const file of closure) {
      assert.notEqual(path.basename(file), "plan-event-bridge.mjs", `${file} is in the watchdog's import closure`);
      for (const specifier of importSpecifiers(file)) {
        assert.doesNotMatch(specifier, /plan-event-bridge/, `${path.basename(file)} imports ${specifier}`);
      }
    }
  });

  test("the scan can see a bridge import (it reports one)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "probe.mjs");
    fs.writeFileSync(file, `import { start } from "./plan-event-bridge.mjs";\nconst later = await import("./plan-event-bridge.mjs");\n`);
    assert.deepEqual(importSpecifiers(file), ["./plan-event-bridge.mjs", "./plan-event-bridge.mjs"]);
  });

  /** A temp copy of the scripts tree: the real files are never damaged. */
  function scriptsCopy() {
    const dir = tmpDir();
    fs.cpSync(scriptsDir, dir, { recursive: true });
    return dir;
  }
  function runWatchdogProcess(scripts, dataDir, hookText = HOOK_TEXT) {
    return spawnSync(process.execPath, [path.join(scripts, "bridge-watchdog.mjs")], {
      input: hookText,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
  }
  function seedConnectedSession(dataDir, pidRecord) {
    const paths = pathsFor(dataDir);
    fs.writeFileSync(paths.pid, JSON.stringify(pidRecord));
    fs.writeFileSync(paths.started, JSON.stringify(started()));
    fs.writeFileSync(paths.connected, JSON.stringify(connectedTrue));
  }

  test("with plan-event-bridge.mjs zeroed (NUL bytes), a stale connected session still gets ONE loud exit-2 notice with the fix", () => {
    const scripts = scriptsCopy();
    fs.writeFileSync(path.join(scripts, "plan-event-bridge.mjs"), Buffer.alloc(4096));
    const dataDir = tmpDir();
    seedConnectedSession(dataDir, stalePid);
    const result = runWatchdogProcess(scripts, dataDir);
    assert.equal(result.status, 2, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trimEnd().split("\n").length, 1, result.stderr);
    assert.match(result.stderr, /bridge down: events are NOT reaching this session/);
    assert.match(result.stderr, /`plan-event-bridge\.mjs start` exited [1-9]/);
    assert.match(result.stderr, /claude plugin update danxbot/);
    // and the real file is untouched
    assert.ok(fs.statSync(path.join(scriptsDir, "plan-event-bridge.mjs")).size > 4096);
  });

  test("with plan-event-bridge.mjs missing entirely it is just as loud", () => {
    const scripts = scriptsCopy();
    fs.rmSync(path.join(scripts, "plan-event-bridge.mjs"));
    const dataDir = tmpDir();
    seedConnectedSession(dataDir, stalePid);
    const result = runWatchdogProcess(scripts, dataDir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /`plan-event-bridge\.mjs start` exited [1-9]/);
  });

  test("healthy: with a fresh heartbeat the watchdog spawns nothing and prints nothing — even with the bridge file gone", () => {
    const scripts = scriptsCopy();
    fs.rmSync(path.join(scripts, "plan-event-bridge.mjs")); // a spawn attempt would be loud
    const dataDir = tmpDir();
    seedConnectedSession(dataDir, { ...freshPid, heartbeatAt: new Date().toISOString() });
    const result = runWatchdogProcess(scripts, dataDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test("throttled: a second invocation inside the throttle window is silent even when the first found a stale bridge", () => {
    const scripts = scriptsCopy();
    fs.writeFileSync(path.join(scripts, "plan-event-bridge.mjs"), Buffer.alloc(64));
    const dataDir = tmpDir();
    seedConnectedSession(dataDir, stalePid);
    assert.equal(runWatchdogProcess(scripts, dataDir).status, 2);
    const second = runWatchdogProcess(scripts, dataDir);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, "");
    assert.equal(second.stderr, "");
  });

  test("a hook with no session id and no usable env is a silent no-op", () => {
    const dataDir = tmpDir();
    const result = spawnSync(process.execPath, [path.join(scriptsDir, "bridge-watchdog.mjs")], {
      input: "{}",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_CODE_SESSION_ID: "" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });
});
