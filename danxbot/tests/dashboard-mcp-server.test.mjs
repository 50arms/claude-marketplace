// dashboard-mcp-server.mjs (DX-4555): the MCP server the plugin ships. With no project `danx-dashboard`
// entry it runs the installed package; with one, the project's entry wins and this copy answers
// the handshake as an empty server. A pre-installed fake package stands in for the real one, so
// nothing here touches the network.
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
import { dashboardUrl, projectDeclaresDashboardServer, standbyReply } from "../scripts/dashboard-mcp-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const LAUNCHER = path.join(PLUGIN_ROOT, "scripts", "dashboard-mcp-server.mjs");
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });

let dataDir;
let projectDir;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dash-mcp-data-"));
  projectDir = mkdtempSync(path.join(tmpdir(), "dash-mcp-project-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const writeMcpJson = (servers) => writeFileSync(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));

function run(input = "", extraEnv = {}) {
  return spawnSync(process.execPath, [LAUNCHER], {
    cwd: projectDir,
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
  });
}

describe("projectDeclaresDashboardServer", () => {
  test("false with no .mcp.json, or one without a danx-dashboard entry", () => {
    assert.equal(projectDeclaresDashboardServer(projectDir), false);
    writeMcpJson({ other: { command: "x" } });
    assert.equal(projectDeclaresDashboardServer(projectDir), false);
  });
  test("true when .mcp.json declares danx-dashboard", () => {
    writeMcpJson({ "danx-dashboard": { command: "node" } });
    assert.equal(projectDeclaresDashboardServer(projectDir), true);
  });
  test("a malformed .mcp.json throws rather than doubling the tools", () => {
    writeFileSync(path.join(projectDir, ".mcp.json"), "{ not json");
    assert.throws(() => projectDeclaresDashboardServer(projectDir));
  });
});

describe("dashboardUrl", () => {
  test("an explicit DANXBOT_DASHBOARD_URL beats the plugin's configured value, which beats nothing", () => {
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "https://a", DANXBOT_PLUGIN_DASHBOARD_URL: "https://b" }), "https://a");
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://b" }), "https://b");
    assert.throws(() => dashboardUrl({}), /no dashboard URL/);
  });
});

describe("standbyReply", () => {
  test("initialize answers with no capabilities, a notification gets no reply, anything else is method-not-found", () => {
    const init = standbyReply(JSON.parse(INITIALIZE));
    assert.deepEqual(init.result.capabilities, {});
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(standbyReply({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.equal(standbyReply({ jsonrpc: "2.0", id: 2, method: "tools/list" }).error.code, -32601);
  });
});

describe("the launcher", () => {
  test("a project that declares danx-dashboard gets an empty server and nothing is installed", () => {
    writeMcpJson({ "danx-dashboard": { command: "node" } });
    const result = run(`${INITIALIZE}\n`);
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout.trim());
    assert.deepEqual(reply.result.capabilities, {});
    assert.equal(result.stderr, "");
  });

  test("a project with no .mcp.json runs the installed package with the hosted URL and without a dispatch's credential", () => {
    recordVersion(dataDir, "0.1.50");
    const bin = installedBinPath(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write(JSON.stringify({ url: process.env.DANXBOT_DASHBOARD_URL, cred: process.env.DANX_DASHBOARD_CREDENTIAL ?? null, repo: process.env.DANX_REPO_NAME ?? null })); process.exit(4);`);
    const result = run("", { DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://danxbot.sageus.ai", DANX_DASHBOARD_CREDENTIAL: "dispatch-secret" });
    assert.equal(result.status, 4, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { url: "https://danxbot.sageus.ai", cred: null, repo: null });
  });

  test("an install failure exits 1 naming the reason on stderr and writes nothing to stdout", () => {
    const result = run("", { CLAUDE_PLUGIN_DATA: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installing the dashboard MCP server failed/);
    assert.equal(result.stdout, "");
  });
});
