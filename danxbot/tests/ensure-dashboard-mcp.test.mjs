// ensure-dashboard-mcp.sh (DX-3811) — installs the pinned danx-dashboard-mcp ONCE into
// `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/<version>/` and prints its entry point, so the
// SubagentStart hook runs it with `node` instead of a cold `npx -y`. A fake `npm` on
// PATH stands in for the registry; nothing here touches the network.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PKG_VERSION, fakeNpm, installedBinPath, makeFakeBinDir, writeFakeBinSourceFile } from "./fixtures/fake-dashboard-mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "ensure-dashboard-mcp.sh");

let dataDir;
let fakeBinDir;
let npmCallsFile;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "ensure-mcp-data-"));
  fakeBinDir = makeFakeBinDir({ npm: fakeNpm() });
  npmCallsFile = path.join(fakeBinDir, "npm-calls.txt");
});
afterEach(() => {
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
  test("a cold call installs the pinned version once and prints the entry point under the data dir, keyed by version", () => {
    const result = runEnsure();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.normalize(result.stdout), path.normalize(installedBinPath(dataDir)));
    assert.equal(npmCalls().length, 1);
    assert.match(npmCalls()[0], new RegExp(`@${PKG_VERSION.replace(/\./g, "\\.")}$`), "installs the exact pinned spec");
    assert.ok(existsSync(installedBinPath(dataDir)));
  });

  test("a warm call prints the same path and never runs npm", () => {
    runEnsure();
    const second = runEnsure();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(path.normalize(second.stdout), path.normalize(installedBinPath(dataDir)));
    assert.equal(npmCalls().length, 1, "the second call must not install again");
  });

  test("leaves no staging directory behind after a successful install", () => {
    runEnsure();
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")), [PKG_VERSION]);
  });

  test("npm failing is reported with its reason, exit 1, and leaves nothing at the final path", () => {
    const result = runEnsure({ npmMode: "fail" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /install_failed/);
    assert.match(result.stderr, /registry unreachable/, "carries npm's own last line");
    assert.ok(!existsSync(installedBinPath(dataDir)));
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")), [], "the failed staging directory is removed");
  });

  test("an install that succeeds but leaves no entry point is a failure, not a path to nothing", () => {
    const result = runEnsure({ npmMode: "no-bin" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /install_incomplete/);
    assert.ok(!existsSync(path.join(dataDir, "dashboard-mcp", PKG_VERSION)));
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
    const finalDir = path.join(dataDir, "dashboard-mcp", PKG_VERSION);
    assert.deepEqual(readdirSync(finalDir), ["node_modules"], "the loser's staged copy must not be moved inside the winner's install");
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")), [PKG_VERSION], "the loser's staging directory is discarded");
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
