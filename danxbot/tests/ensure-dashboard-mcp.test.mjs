// ensure-dashboard-mcp.sh (DX-3811) — installs the recorded danx-dashboard-mcp version ONCE into
// `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/<version>/` and prints its entry point, so the
// SubagentStart hook runs it with `node` instead of a cold `npx -y`. Which version is the
// registry's `latest` as recorded at session start (DX-4321). A fake `npm` on PATH stands in
// for the install and a fake registry for the version lookup; nothing here touches the network.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_VERSION, fakeNpm, installFakeMcp, installedBinPath, makeFakeBinDir, recordVersion, recordedVersion, writeFakeBinSourceFile } from "./fixtures/fake-dashboard-mcp.mjs";
import { REGISTRY_BASE_URL_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "ensure-dashboard-mcp.sh");

let dataDir;
let fakeBinDir;
let npmCallsFile;
let registry;
beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "ensure-mcp-data-"));
  fakeBinDir = makeFakeBinDir({ npm: fakeNpm() });
  npmCallsFile = path.join(fakeBinDir, "npm-calls.txt");
  registry = await startFakeRegistry({ version: TEST_VERSION });
});
afterEach(async () => {
  await registry.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

function runEnsure({ npmMode = "ok", extraEnv = {}, withDataDir = true, args = [] } = {}) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
    FAKE_NPM_MODE: npmMode,
    FAKE_NPM_CALLS_FILE: npmCallsFile,
    FAKE_BIN_SOURCE_FILE: writeFakeBinSourceFile(),
    [REGISTRY_BASE_URL_ENV]: registry.url,
    ...extraEnv,
  };
  if (withDataDir) env.CLAUDE_PLUGIN_DATA = dataDir;
  else delete env.CLAUDE_PLUGIN_DATA;
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
}

function npmCalls() {
  return existsSync(npmCallsFile) ? readFileSync(npmCallsFile, "utf8").trim().split("\n") : [];
}

describe("ensure-dashboard-mcp.sh", () => {
  test("a cold call with nothing recorded resolves the registry's latest, records it, installs that version once and prints the entry point keyed by version", () => {
    const result = runEnsure();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(recordedVersion(dataDir), TEST_VERSION);
    assert.equal(path.normalize(result.stdout), path.normalize(installedBinPath(dataDir)));
    assert.equal(registry.requests().length, 1);
    assert.equal(npmCalls().length, 1);
    assert.match(npmCalls()[0], new RegExp(`@${TEST_VERSION.replace(/\./g, "\\.")}$`), "installs the exact recorded spec");
    assert.ok(existsSync(installedBinPath(dataDir)));
  });

  test("a warm call prints the same path, never runs npm and never asks the registry", () => {
    runEnsure();
    const second = runEnsure();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(path.normalize(second.stdout), path.normalize(installedBinPath(dataDir)));
    assert.equal(npmCalls().length, 1, "the second call must not install again");
    assert.equal(registry.requests().length, 1, "only the first call (no record) resolved the registry");
  });

  test("a call that finds a record installs THAT version and makes no registry request, even when the registry has moved", () => {
    recordVersion(dataDir, "0.1.7");
    const result = runEnsure();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.normalize(result.stdout), path.normalize(installedBinPath(dataDir, "0.1.7")));
    assert.match(npmCalls()[0], /@0\.1\.7$/);
    assert.deepEqual(registry.requests(), []);
  });

  test("--prewarm after the registry's latest moved A to B refreshes the record and installs B into its own directory, A untouched", () => {
    installFakeMcp(dataDir, "0.1.7");
    registry.setVersion("0.1.8");
    const prewarm = runEnsure({ args: ["--prewarm"] });
    assert.equal(prewarm.status, 0);
    assert.equal(recordedVersion(dataDir), "0.1.8");
    assert.ok(existsSync(installedBinPath(dataDir, "0.1.8")), "the new version installed lazily into its own directory");
    assert.ok(existsSync(installedBinPath(dataDir, "0.1.7")), "the previous version's directory is untouched");
    assert.match(npmCalls().at(-1), /@0\.1\.8$/);
    const after = runEnsure();
    assert.equal(path.normalize(after.stdout), path.normalize(installedBinPath(dataDir, "0.1.8")), "the next call runs B");
  });

  test("with the registry down and a record, --prewarm keeps the recorded version and still installs it", () => {
    recordVersion(dataDir, "0.1.7");
    registry.setMode("status-500");
    const prewarm = runEnsure({ args: ["--prewarm"] });
    assert.equal(prewarm.status, 0);
    assert.equal(prewarm.stdout + prewarm.stderr, "");
    assert.equal(recordedVersion(dataDir), "0.1.7");
    assert.ok(existsSync(installedBinPath(dataDir, "0.1.7")));
  });

  test("nothing recorded and the registry unreadable: exit 1, one line naming the reason and that nothing can start, no install attempted", () => {
    registry.setMode("status-500");
    const result = runEnsure();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.match(result.stderr, /HTTP 500/);
    assert.match(result.stderr, /nothing .*can start/);
    assert.deepEqual(npmCalls(), []);
  });

  test("leaves no staging directory behind after a successful install", () => {
    recordVersion(dataDir, TEST_VERSION);
    runEnsure();
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).sort(), [TEST_VERSION, "current"]);
  });

  test("npm failing is reported with its reason, exit 1, and leaves nothing at the final path", () => {
    const result = runEnsure({ npmMode: "fail" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /install_failed/);
    assert.match(result.stderr, /registry unreachable/, "carries npm's own last line");
    assert.ok(!existsSync(installedBinPath(dataDir)));
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")), ["current"], "the failed staging directory is removed");
  });

  test("an install that succeeds but leaves no entry point is a failure, not a path to nothing", () => {
    const result = runEnsure({ npmMode: "no-bin" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /install_incomplete/);
    assert.ok(!existsSync(path.join(dataDir, "dashboard-mcp", TEST_VERSION)));
  });

  test("an install that outlives its budget is reported as a timeout", () => {
    const result = runEnsure({ npmMode: "hang", extraEnv: { DASHBOARD_MCP_INSTALL_TIMEOUT_SECS: "1" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^timeout:/);
  });

  test("a missing CLAUDE_PLUGIN_DATA is a loud failure, not an install into the wrong place", () => {
    const result = runEnsure({ withDataDir: false });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLAUDE_PLUGIN_DATA is not set/);
    assert.deepEqual(npmCalls(), []);
  });

  test("losing a race to a concurrent install uses the winner's and nests nothing inside it", () => {
    const result = runEnsure({ npmMode: "race" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.normalize(result.stdout), path.normalize(installedBinPath(dataDir)));
    const finalDir = path.join(dataDir, "dashboard-mcp", TEST_VERSION);
    assert.deepEqual(readdirSync(finalDir), ["node_modules"], "the loser's staged copy must not be moved inside the winner's install");
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).sort(), [TEST_VERSION, "current"], "the loser's staging directory is discarded");
  });

  test("removes a staging directory orphaned by a killed install, and keeps a recent one (a concurrent caller's)", () => {
    const root = path.join(dataDir, "dashboard-mcp");
    const orphan = path.join(root, ".stage-orphan");
    const recent = path.join(root, ".stage-recent");
    mkdirSync(orphan, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphan, twoHoursAgo, twoHoursAgo);
    runEnsure();
    assert.ok(!existsSync(orphan), "the stale staging directory is removed");
    assert.ok(existsSync(recent), "a fresh staging directory is left alone");
  });

  describe("pruning old version directories (DX-4321)", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    function seedVersionDirs() {
      const root = path.join(dataDir, "dashboard-mcp");
      const old = path.join(root, "0.1.1");
      const young = path.join(root, "0.1.2");
      mkdirSync(path.join(old, "node_modules"), { recursive: true });
      mkdirSync(path.join(young, "node_modules"), { recursive: true });
      utimesSync(old, twoHoursAgo, twoHoursAgo);
      return { root, old, young };
    }

    test("a cold install removes every version directory but the recorded one that is over an hour old, and keeps a younger one", () => {
      const { old, young } = seedVersionDirs();
      const result = runEnsure();
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!existsSync(old), "the old version's directory is removed");
      assert.ok(existsSync(young), "a version directory under an hour old is kept");
      assert.ok(existsSync(installedBinPath(dataDir)), "the recorded version is installed");
    });

    test("--prewarm prunes too, and never removes the recorded version even when its directory is over an hour old", () => {
      installFakeMcp(dataDir, TEST_VERSION);
      const recordedDir = path.join(dataDir, "dashboard-mcp", TEST_VERSION);
      utimesSync(recordedDir, twoHoursAgo, twoHoursAgo);
      const { old, young } = seedVersionDirs();
      const result = runEnsure({ args: ["--prewarm"] });
      assert.equal(result.status, 0);
      assert.ok(!existsSync(old));
      assert.ok(existsSync(young));
      assert.ok(existsSync(installedBinPath(dataDir)), "the recorded version's install survives");
      assert.equal(recordedVersion(dataDir), TEST_VERSION);
    });

    test("a staging directory and the record file are never taken for a version directory", () => {
      installFakeMcp(dataDir, TEST_VERSION);
      const stage = path.join(dataDir, "dashboard-mcp", ".stage-live");
      mkdirSync(stage, { recursive: true });
      runEnsure({ args: ["--prewarm"] });
      assert.ok(existsSync(stage), "a recent staging directory is a concurrent caller's, not a stale version");
      assert.equal(recordedVersion(dataDir), TEST_VERSION);
    });
  });

  test("the SessionStart hook entry runs the prewarm, async, so a failure can never block a session", () => {
    const hooks = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
    const entries = hooks.hooks.SessionStart.flatMap((group) => group.hooks).filter((h) => h.command.includes("ensure-dashboard-mcp.sh"));
    assert.equal(entries.length, 1);
    assert.match(entries[0].command, /ensure-dashboard-mcp.sh --prewarm$/);
    assert.equal(entries[0].async, true);
  });

  test("--prewarm installs the same way but prints nothing", () => {
    const result = runEnsure({ args: ["--prewarm"] });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.ok(existsSync(installedBinPath(dataDir)));
  });

  test("--prewarm never fails a session: a broken install and a missing data dir are both silent exit 0", () => {
    const broken = runEnsure({ args: ["--prewarm"], npmMode: "fail" });
    assert.equal(broken.status, 0);
    assert.equal(broken.stdout + broken.stderr, "");
    const noData = runEnsure({ args: ["--prewarm"], withDataDir: false });
    assert.equal(noData.status, 0);
    assert.equal(noData.stdout + noData.stderr, "");
  });
});
