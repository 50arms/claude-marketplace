// DX-4321 — the session-start refresh, end to end across every entry point that runs
// `@thehammer/danx-dashboard-mcp`. The plugin carries no version: the registry's `latest` is read
// at session start and recorded; every other hook reads the record. A fake registry
// (fixtures/fake-registry.mjs) and a fake `npm` on PATH stand in for npm; nothing here touches
// the network.
//
//   - AC1: the registry's `latest` moves A to B and the next session start of EACH entry point
//     (`ensure-dashboard-mcp.sh --prewarm`, `event-hook.sh SessionStart`,
//     `background-work-report.mjs session-start`, `plan-event-bridge.mjs start`) ends up running
//     B, with no plugin file changed.
//   - A hook that is not a session start (SubagentStart, PostToolUse, Stop, the watchdog's bridge
//     restart) makes ZERO registry requests; one that finds no record resolves it itself.
//   - AC4: a session start that cannot read the registry says so in ONE line naming the reason and
//     the version still in use and keeps the recorded version; with none, nothing runs.
import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as bridge from "../scripts/plan-event-bridge.mjs";
import { runHook as runBackgroundWork } from "../scripts/background-work-report.mjs";
import { runActivity } from "../scripts/activity-report.mjs";
import { readRecordedSpec, readRecordedVersion } from "../scripts/lib/dashboard-mcp-package.mjs";
import { PKG_NAME, fakeNpm, makeFakeBinDir, recordFilePath, recordVersion, recordedVersion, writeFakeBinSourceFile } from "./fixtures/fake-dashboard-mcp.mjs";
import { REGISTRY_BASE_URL_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SESSION = "11111111-2222-4333-8444-555555555555";
const A = "0.1.7";
const B = "0.1.8";

const registry = await startFakeRegistry({ version: A });
after(() => registry.stop());

let dataDir;
let planHome;
let fakeBinDir;
let baseEnv;
beforeEach(() => {
  registry.setVersion(A);
  dataDir = mkdtempSync(path.join(tmpdir(), "mcp-refresh-data-"));
  planHome = mkdtempSync(path.join(tmpdir(), "mcp-refresh-home-"));
  fakeBinDir = makeFakeBinDir({ npm: fakeNpm() });
  const connections = path.join(planHome, ".config", "danxbot", "plan-sessions");
  mkdirSync(connections, { recursive: true });
  writeFileSync(path.join(connections, `${SESSION}.json`), JSON.stringify({ schemaVersion: 1 }));
  baseEnv = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CLAUDE_PLUGIN_DATA: dataDir,
    DANXBOT_PLAN_SESSIONS_HOME: planHome,
    CLAUDE_CODE_MESSAGING_SOCKET: "socket-path",
    CLAUDE_CODE_MESSAGING_TOKEN: "inbox-secret",
    [REGISTRY_BASE_URL_ENV]: registry.url,
    FAKE_NPM_MODE: "ok",
    FAKE_NPM_CALLS_FILE: path.join(fakeBinDir, "npm-calls.txt"),
    FAKE_BIN_SOURCE_FILE: writeFakeBinSourceFile(),
    FAKE_MCP_MODE: "success",
    FAKE_MCP_TEXT: "event text",
  };
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(planHome, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

const npmCalls = () => {
  const file = path.join(fakeBinDir, "npm-calls.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};
const installedVersions = () => readdirSync(path.join(dataDir, "dashboard-mcp")).filter((name) => /^\d/.test(name));

/** The sha256 over every file under the plugin tree, tests and node_modules excluded: "no plugin file changed". */
function pluginTreeHash() {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      if (dir === PLUGIN_ROOT && (entry === "tests" || entry === "node_modules")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(PLUGIN_ROOT, full)).update(readFileSync(full));
    }
  };
  walk(PLUGIN_ROOT);
  return hash.digest("hex");
}

function runScript(script, args, { input = "", env = baseEnv } = {}) {
  return spawnSync("bash", [path.join(PLUGIN_ROOT, "scripts", script), ...args], { input, encoding: "utf8", env });
}

// ------------------------------------------------------------- the four session-start entry points

/** Each runs ONE session start against the fake registry; `ranVersion()` is the version it ran or installed. */
const ENTRY_POINTS = {
  "ensure-dashboard-mcp.sh --prewarm": {
    async run() {
      const result = runScript("ensure-dashboard-mcp.sh", ["--prewarm"]);
      assert.equal(result.status, 0);
    },
    ranVersion: () => npmCalls().at(-1).split("@").at(-1),
  },
  "event-hook.sh SessionStart": {
    async run() {
      const result = runScript("event-hook.sh", ["SessionStart"], { input: JSON.stringify({ session_id: SESSION, source: "startup" }) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "event text\n", "no extra line when the refresh worked");
    },
    ranVersion: () => npmCalls().at(-1).split("@").at(-1),
  },
  "background-work-report.mjs session-start": {
    spawned: [],
    async run() {
      this.spawned.length = 0;
      const outcome = await runBackgroundWork("session-start", { session_id: SESSION }, { env: baseEnv, platform: "linux", spawnFn: (command, args) => (this.spawned.push(args), { status: 0, stdout: '{"ok":true,"applied":true}' }) });
      assert.equal(outcome.line, null);
    },
    ranVersion() {
      return this.spawned[0][1].slice(this.spawned[0][1].lastIndexOf("@") + 1);
    },
  },
  "plan-event-bridge.mjs start": {
    async run() {
      const result = await bridge.start({ env: baseEnv, sessionId: SESSION, sessionStart: true, spawnRun: () => ({ pid: 1 }), waitVerdict: async () => null, stderr: () => {}, post: async () => {} });
      assert.equal(result.started, true);
    },
    // The command the bridge's run process builds: `npx -y <name>@<recorded version> bridge`.
    ranVersion() {
      const { args } = bridge.bridgeCommand({ resumeIds: [], spec: readRecordedSpec(baseEnv), platform: "linux" });
      assert.equal(args[1].slice(0, args[1].lastIndexOf("@")), PKG_NAME);
      return args[1].slice(args[1].lastIndexOf("@") + 1);
    },
  },
};

describe("AC1 — the registry's latest moves A to B and the next session start runs B, with no plugin file changed", () => {
  for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
    test(name, async () => {
      const treeBefore = pluginTreeHash();
      await entry.run.call(entry);
      assert.equal(entry.ranVersion.call(entry), A, "the first session start runs what the registry served");
      assert.equal(readRecordedVersion(baseEnv), A);

      registry.setVersion(B);
      await entry.run.call(entry);
      assert.equal(entry.ranVersion.call(entry), B, "the next session start runs B");
      assert.equal(readRecordedVersion(baseEnv), B);
      assert.equal(pluginTreeHash(), treeBefore, "no file in the plugin changed");
    });
  }

  test("ensure-dashboard-mcp.sh installs B into its own directory and leaves A's untouched", async () => {
    await ENTRY_POINTS["ensure-dashboard-mcp.sh --prewarm"].run();
    registry.setVersion(B);
    await ENTRY_POINTS["ensure-dashboard-mcp.sh --prewarm"].run();
    assert.deepEqual(installedVersions().sort(), [A, B]);
  });
});

// ------------------------------------------------------------- hooks that are not a session start

describe("a hook that is not a session start reads the record and makes ZERO registry requests", () => {
  beforeEach(() => {
    recordVersion(dataDir, A);
    registry.setVersion(B); // the registry has moved on; only a session start may notice
  });
  const requests = () => registry.requests().length;

  test("SubagentStart (event-hook.sh)", () => {
    const before = requests();
    const result = runScript("event-hook.sh", ["SubagentStart"], { input: JSON.stringify({ session_id: SESSION }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests(), before);
    assert.equal(readRecordedVersion(baseEnv), A);
    assert.match(npmCalls().at(-1), new RegExp(`@${A.replace(/\./g, "\\.")}$`));
  });

  test("PostToolUse and SubagentStart (activity-report.mjs, through the real ensure-dashboard-mcp.sh)", () => {
    const before = requests();
    const spawned = [];
    for (const mode of ["subagent-start", "subagent-stop"]) {
      const payload = JSON.stringify({ session_id: SESSION, hook_event_name: mode === "subagent-start" ? "SubagentStart" : "SubagentStop" });
      runActivity(mode, payload, { env: baseEnv, spawnFn: (command, args) => (spawned.push(args[0]), { status: 0, stdout: '{"ok":true}' }) });
    }
    assert.equal(spawned.length, 2);
    assert.ok(spawned.every((bin) => path.normalize(bin).includes(`${path.sep}${A}${path.sep}`)), `ran the recorded version: ${spawned}`);
    assert.equal(requests(), before);
  });

  for (const mode of ["heartbeat", "stop", "subagent-stop", "stop-failure"]) {
    test(`background-work-report.mjs ${mode}`, async () => {
      const before = requests();
      const spawned = [];
      await runBackgroundWork(mode, { session_id: SESSION, agent_id: "a1", background_tasks: [] }, { env: baseEnv, platform: "linux", spawnFn: (command, args) => (spawned.push(args), { status: 0, stdout: '{"ok":true,"applied":true}' }) });
      assert.equal(spawned.length, 1, "it reported");
      assert.equal(spawned[0][1], `${PKG_NAME}@${A}`);
      assert.equal(requests(), before);
    });
  }

  test("the bridge's start without a SessionStart (a plan_connect, the watchdog's restart)", async () => {
    const before = requests();
    for (const extra of [{ intent: "connect" }, { intent: "resume", restartTrigger: "watchdog" }]) {
      const dir = mkdtempSync(path.join(tmpdir(), "mcp-refresh-bridge-"));
      const env = { ...baseEnv, CLAUDE_PLUGIN_DATA: dir };
      recordVersion(dir, A);
      const result = await bridge.start({ env, sessionId: SESSION, spawnRun: () => ({ pid: 1 }), waitVerdict: async () => null, stderr: () => {}, post: async () => {}, ...extra });
      assert.equal(result.started, true);
      assert.equal(readRecordedVersion(env), A);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(requests(), before);
  });
});

describe("a hook that finds no record resolves it itself through the same function and records it", () => {
  beforeEach(() => registry.setVersion(B));

  test("activity-report.mjs (through ensure-dashboard-mcp.sh)", () => {
    const before = registry.requests().length;
    runActivity("subagent-start", JSON.stringify({ session_id: SESSION, hook_event_name: "SubagentStart" }), { env: baseEnv, spawnFn: () => ({ status: 0, stdout: '{"ok":true}' }) });
    assert.equal(recordedVersion(dataDir), B);
    assert.equal(registry.requests().length - before, 1);
  });

  for (const mode of ["heartbeat", "stop"]) {
    test(`background-work-report.mjs ${mode}`, async () => {
      const spawned = [];
      await runBackgroundWork(mode, { session_id: SESSION, agent_id: "a1", background_tasks: [] }, { env: baseEnv, platform: "linux", spawnFn: (command, args) => (spawned.push(args), { status: 0, stdout: '{"ok":true,"applied":true}' }) });
      assert.equal(recordedVersion(dataDir), B);
      assert.equal(spawned[0][1], `${PKG_NAME}@${B}`);
    });
  }

  test("the bridge's start without a SessionStart", async () => {
    const result = await bridge.start({ env: baseEnv, sessionId: SESSION, intent: "connect", spawnRun: () => ({ pid: 1 }), waitVerdict: async () => null, stderr: () => {}, post: async () => {} });
    assert.equal(result.started, true);
    assert.equal(recordedVersion(dataDir), B);
  });
});

// ------------------------------------------------------------- AC4: never silent

describe("AC4 — a session start that cannot read the registry says so, once, and keeps the recorded version", () => {
  test("background-work-report.mjs session-start: one line naming the reason and the version in use; it still reports with that version", async () => {
    recordVersion(dataDir, A);
    registry.setMode("status-500");
    const spawned = [];
    const outcome = await runBackgroundWork("session-start", { session_id: SESSION }, { env: baseEnv, platform: "linux", spawnFn: (command, args) => (spawned.push(args), { status: 0, stdout: '{"ok":true,"applied":true}' }) });
    assert.match(outcome.line, /could not refresh/);
    assert.match(outcome.line, /HTTP 500/);
    assert.ok(outcome.line.includes(A));
    assert.equal(outcome.line.includes("\n"), false);
    assert.equal(outcome.missingVersion, false);
    assert.equal(spawned[0][1], `${PKG_NAME}@${A}`);
  });

  test("background-work-report.mjs session-start with NO recorded version: nothing is reported and the line says so", async () => {
    registry.setMode("status-500");
    const spawned = [];
    const outcome = await runBackgroundWork("session-start", { session_id: SESSION }, { env: baseEnv, platform: "linux", spawnFn: (command, args) => (spawned.push(args), { status: 0 }) });
    assert.equal(outcome.missingVersion, true);
    assert.match(outcome.line, /nothing that runs it can start/);
    assert.deepEqual(spawned, []);
  });

  test("the background-work-report.mjs process exits non-zero and prints the line when nothing can run", () => {
    registry.setMode("status-500");
    const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "background-work-report.mjs"), "session-start"], { input: JSON.stringify({ session_id: SESSION }), encoding: "utf8", env: baseEnv });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nothing that runs it can start/);
    assert.equal(result.stderr.trim().split("\n").length, 1);
  });

  test("background-work-report.mjs session-start of a session that is not plan-connected needs no package: no registry request, no line, exit 0", async () => {
    registry.setMode("status-500");
    const before = registry.requests().length;
    const outcome = await runBackgroundWork("session-start", { session_id: "not-connected-session" }, { env: baseEnv, platform: "linux", spawnFn: () => assert.fail("an unconnected session never reports") });
    assert.deepEqual(outcome, { line: null, missingVersion: false });
    assert.equal(registry.requests().length, before);
  });

  test("the bridge posts ONE notice naming the reason and the version in use, and still starts on that version", async () => {
    recordVersion(dataDir, A);
    registry.setMode("status-500");
    const posted = [];
    const spawnRun = [];
    const result = await bridge.start({
      env: baseEnv,
      sessionId: SESSION,
      intent: "connect",
      sessionStart: true,
      spawnRun: () => (spawnRun.push(1), { pid: 1 }),
      waitVerdict: async () => null,
      stderr: () => {},
      post: async (notice) => posted.push(notice),
    });
    assert.equal(result.started, true, "the recorded version keeps the bridge running");
    assert.equal(posted.length, 1);
    assert.ok(posted[0].startsWith("[danxbot plan event]"));
    assert.match(posted[0], /could not refresh/);
    assert.match(posted[0], /HTTP 500/);
    assert.ok(posted[0].includes(A));
    assert.equal(readRecordedVersion(baseEnv), A);
    assert.equal(spawnRun.length, 1);
  });

  test("the bridge's notice falls back to stderr and exit 2 (asyncRewake) when the inbox cannot take it", async () => {
    recordVersion(dataDir, A);
    registry.setMode("status-500");
    const stderr = [];
    const result = await bridge.start({
      env: baseEnv,
      sessionId: SESSION,
      intent: "connect",
      sessionStart: true,
      spawnRun: () => ({ pid: 1 }),
      waitVerdict: async () => null,
      stderr: (text) => stderr.push(text),
      post: async () => {
        throw new Error("inbox closed");
      },
    });
    assert.equal(result.started, true);
    assert.equal(result.exitCode, 2);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /could not refresh.*HTTP 500/);
  });

  test("the bridge with NO recorded version starts nothing and tells the session why through its failure notice", async () => {
    registry.setMode("status-500");
    const posted = [];
    let spawned = 0;
    const result = await bridge.start({
      env: baseEnv,
      sessionId: SESSION,
      intent: "connect",
      sessionStart: true,
      spawnRun: () => (spawned += 1, { pid: 1 }),
      waitVerdict: async () => null,
      stderr: () => {},
      post: async (notice) => posted.push(notice),
    });
    assert.equal(result.started, false);
    assert.equal(spawned, 0);
    assert.equal(posted.length, 1);
    assert.match(posted[0], /bridge down: events are NOT reaching this session/);
    assert.match(posted[0], /HTTP 500/);
    assert.match(posted[0], /nothing that runs it can start/);
  });

  test("the bridge with no recorded version and an unreachable inbox exits 2 with the notice on stderr", async () => {
    registry.setMode("status-500");
    const stderr = [];
    const result = await bridge.start({
      env: baseEnv,
      sessionId: SESSION,
      intent: "connect",
      sessionStart: true,
      spawnRun: () => ({ pid: 1 }),
      waitVerdict: async () => null,
      stderr: (text) => stderr.push(text),
      post: async () => {
        throw new Error("inbox closed");
      },
    });
    assert.equal(result.started, false);
    assert.equal(result.exitCode, 2);
    assert.match(stderr.join(""), /nothing that runs it can start/);
  });

  test("a bridge session start that is not known to want events stays quiet about a kept version (no cursor, not a plan_connect)", async () => {
    recordVersion(dataDir, A);
    registry.setMode("status-500");
    const posted = [];
    const result = await bridge.start({ env: baseEnv, sessionId: SESSION, intent: "resume", sessionStart: true, spawnRun: () => ({ pid: 1 }), waitVerdict: async () => null, stderr: () => {}, post: async (n) => posted.push(n) });
    assert.equal(result.started, true);
    assert.deepEqual(posted, []);
  });

  test("the record file is where every reader looks: dashboard-mcp/current under the plugin data dir", () => {
    recordVersion(dataDir, A);
    assert.equal(recordFilePath(dataDir), path.join(dataDir, "dashboard-mcp", "current"));
    assert.equal(readRecordedVersion(baseEnv), A);
  });
});
