// dashboard-mcp-server.mjs (DX-4555, DX-4578): the MCP server the plugin ships, the one dashboard server of every session.
// A pre-installed fake package stands in for the real one, so nothing here touches the network.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedBinPath, recordVersion } from "./fixtures/fake-dashboard-mcp.mjs";
import { bashFor, dashboardUrl } from "../scripts/dashboard-mcp-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const LAUNCHER = path.join(PLUGIN_ROOT, "scripts", "dashboard-mcp-server.mjs");

let dataDir;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dash-mcp-data-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function run(input = "", extraEnv = {}) {
  return spawnSync(process.execPath, [LAUNCHER], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, ...extraEnv },
  });
}

describe("bashFor: the bash that runs the install script", () => {
  const none = () => null;
  const never = () => false;
  test("off Windows it is plain `bash` from PATH", () => {
    assert.equal(bashFor("linux", {}, none, never), "bash");
    assert.equal(bashFor("darwin", {}, none, never), "bash");
  });
  test("on Windows CLAUDE_CODE_GIT_BASH_PATH wins, and a missing file is refused by name", () => {
    const p = "D:\\tools\\Git\\bin\\bash.exe";
    assert.equal(bashFor("win32", { CLAUDE_CODE_GIT_BASH_PATH: p }, () => "C:/x/mingw64/libexec/git-core", (f) => f === p), p);
    assert.throws(() => bashFor("win32", { CLAUDE_CODE_GIT_BASH_PATH: p }, none, never), /CLAUDE_CODE_GIT_BASH_PATH names .*does not exist/);
  });
  test("on Windows without it, Git for Windows' bin\\bash.exe is found from `git --exec-path`", () => {
    const seen = [];
    const got = bashFor("win32", {}, () => "C:/Program Files/Git/mingw64/libexec/git-core", (f) => (seen.push(f), true));
    assert.equal(got, "C:\\Program Files\\Git\\bin\\bash.exe");
    assert.deepEqual(seen, ["C:\\Program Files\\Git\\bin\\bash.exe"]);
  });
  test("on Windows it fails loudly, telling git-not-runnable from no bash beside git, naming the fix", () => {
    assert.throws(() => bashFor("win32", {}, none, never), /no Git Bash found: `git --exec-path` could not be run.*CLAUDE_CODE_GIT_BASH_PATH/);
    assert.throws(
      () => bashFor("win32", {}, () => "C:/Program Files/Git/mingw64/libexec/git-core", never),
      /git runs \(exec path C:\/Program Files\/Git\/mingw64\/libexec\/git-core\) but C:\\Program Files\\Git\\bin\\bash\.exe does not exist/,
    );
  });
});

describe("dashboardUrl", () => {
  test("an explicit DANXBOT_DASHBOARD_URL beats the plugin's configured value, which beats nothing", () => {
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "https://a", DANXBOT_PLUGIN_DASHBOARD_URL: "https://b" }), "https://a");
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://b" }), "https://b");
    assert.throws(() => dashboardUrl({}), /no dashboard URL/);
  });
});

describe("the launcher", () => {
  test("the launcher runs the installed package with the hosted URL and without a dispatch's credential", () => {
    recordVersion(dataDir, "0.1.50");
    const bin = installedBinPath(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write(JSON.stringify({ url: process.env.DANXBOT_DASHBOARD_URL, cred: process.env.DANX_DASHBOARD_CREDENTIAL ?? null, repo: process.env.DANX_REPO_NAME ?? null })); process.exit(4);`);
    const result = run("", { DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://danxbot.sageus.ai", DANX_DASHBOARD_CREDENTIAL: "dispatch-secret" });
    assert.equal(result.status, 4, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { url: "https://danxbot.sageus.ai", cred: null, repo: null });
  });

  test("a folder whose .mcp.json declares danx-dashboard still gets the real server: the launcher has no standby mode", () => {
    recordVersion(dataDir, "0.1.50");
    const bin = installedBinPath(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write("real-server"); process.exit(4);`);
    const project = mkdtempSync(path.join(tmpdir(), "dash-mcp-project-"));
    try {
      writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "danx-dashboard": { command: "node", args: ["x.mjs"] } } }));
      const result = run("", { CLAUDE_PROJECT_DIR: project, DANXBOT_DASHBOARD_URL: "https://danxbot.sageus.ai" });
      assert.equal(result.status, 4, result.stderr);
      assert.equal(result.stdout, "real-server");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("an install failure exits 1 naming the reason on stderr and writes nothing to stdout", () => {
    const result = run("", { CLAUDE_PLUGIN_DATA: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installing the dashboard MCP server failed/);
    assert.equal(result.stdout, "");
  });
});
