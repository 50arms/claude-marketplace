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
import { dashboardUrl } from "../scripts/dashboard-mcp-server.mjs";

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

  test("an install failure exits 1 naming the reason on stderr and writes nothing to stdout", () => {
    const result = run("", { CLAUDE_PLUGIN_DATA: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installing the dashboard MCP server failed/);
    assert.equal(result.stdout, "");
  });
});
