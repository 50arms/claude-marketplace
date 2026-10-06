// DX-4321 — the session-start refresh, end to end across every entry point that runs
// `@thehammer/danx-dashboard-mcp`. The plugin carries no version: the registry's `latest` is read
// at session start and recorded; every other hook reads the record. A fake registry
// (fixtures/fake-registry.mjs) and a fake `npm` on PATH stand in for npm; nothing here touches
// the network.
//
//   - AC1: the registry's `latest` moves A to B and the next session start of EACH entry point
//     (`ensure-dashboard-mcp.sh --prewarm`,
//     `background-work-report.mjs session-start`) ends up running
//     B, with no plugin file changed.
//   - A hook that is not a session start (SubagentStart, PostToolUse, Stop) makes ZERO registry requests; one that finds no record resolves it itself.
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
import { runHook as runBackgroundWork } from "../scripts/background-work-report.mjs";
import { runActivity } from "../scripts/activity-report.mjs";
import { requireRecordedSpec, recordedVersionOrNull } from "../scripts/lib/dashboard-mcp-package.mjs";
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
    CLAUDE_CODE_MESSAGING_TOKEN: "messaging-secret",
    [REGISTRY_BASE_URL_ENV]: registry.url,
    FAKE_NPM_MODE: "ok",
    FAKE_NPM_CALLS_FILE: path.join(fakeBinDir, "npm-calls.txt"),
    FAKE_BIN_SOURCE_FILE: writeFakeBinSourceFile(),
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

// ------------------------------------------------------------- the session-start entry points

/** Each runs ONE session start against the fake registry; `ranVersion()` is the version it ran or installed. */
const ENTRY_POINTS = {
  "ensure-dashboard-mcp.sh --prewarm": {
    async run() {
      const result = runScript("ensure-dashboard-mcp.sh", ["--prewarm"]);
      assert.equal(result.status, 0);
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
};

describe("AC1 — the registry's latest moves A to B and the next session start runs B, with no plugin file changed", () => {
  for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
    test(name, async () => {
      const treeBefore = pluginTreeHash();
      await entry.run.call(entry);
      assert.equal(entry.ranVersion.call(entry), A, "the first session start runs what the registry served");
      assert.equal(recordedVersionOrNull(baseEnv), A);

      registry.setVersion(B);
      await entry.run.call(entry);
      assert.equal(entry.ranVersion.call(entry), B, "the next session start runs B");
      assert.equal(recordedVersionOrNull(baseEnv), B);
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

  test("the record file is where every reader looks: dashboard-mcp/current under the plugin data dir", () => {
    recordVersion(dataDir, A);
    assert.equal(recordFilePath(dataDir), path.join(dataDir, "dashboard-mcp", "current"));
    assert.equal(recordedVersionOrNull(baseEnv), A);
  });
});
