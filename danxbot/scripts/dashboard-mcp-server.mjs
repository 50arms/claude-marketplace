#!/usr/bin/env node
// DX-4555: the danx-dashboard MCP server this plugin ships (plugin.json `mcpServers`), so a
// tester who installs the plugin never writes a `.mcp.json`.
//
// WHAT IT RUNS. The same installed `@thehammer/danx-dashboard-mcp` the hooks run
// (ensure-dashboard-mcp.sh installs it once into the plugin data dir; the package's own
// `dist/index.js` is then run with plain `node`, never a cold `npx -y`).
//
// WHICH DASHBOARD. `dashboardUrl(env)`: DANXBOT_DASHBOARD_URL when set (the user's shell, or an `env`
// block in a repo's committed `.claude/settings.json`, which is the per-repo or per-company override),
// else the plugin's `userConfig.dashboard_url` (plugin.json passes it as DANXBOT_PLUGIN_DASHBOARD_URL;
// its default is the hosted dashboard). Claude Code reads `pluginConfigs` from user and managed
// settings only, never from a project's. DANX_REPO_NAME / DANXBOT_BOARD_NAME stay unset: the session names its
// board per call (the `board` argument) or through `plan_connect`.
//
// The ONE dashboard server: no connected repo declares its own `danx-dashboard` entry any more (DX-4578), so Claude
// Code lists exactly this one, named `plugin:danxbot:danx-dashboard`, in every folder.
//
// stdout is the MCP stream, so nothing here may print to it: every notice goes to stderr.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The dashboard this session talks to: an explicit DANXBOT_DASHBOARD_URL, else the plugin's configured value. */
export function dashboardUrl(env) {
  const url = env.DANXBOT_DASHBOARD_URL || env.DANXBOT_PLUGIN_DASHBOARD_URL;
  if (!url) throw new Error("no dashboard URL: set DANXBOT_DASHBOARD_URL, or the plugin's dashboard_url option");
  return url;
}

function fail(reason) {
  console.error(`[danxbot dashboard MCP] ${reason}`);
  process.exit(1);
}

function runServer() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) fail("CLAUDE_PLUGIN_ROOT is not set: this launcher only runs as the danxbot plugin's MCP server");
  const ensure = spawnSync("bash", [path.join(root, "scripts", "ensure-dashboard-mcp.sh")], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (ensure.error) fail(`could not run bash to install the dashboard MCP server: ${ensure.error.message}`);
  if (ensure.status !== 0) fail(`installing the dashboard MCP server failed: ${ensure.stderr.trim() || `exit ${ensure.status}`}`);
  const env = { ...process.env };
  try {
    env.DANXBOT_DASHBOARD_URL = dashboardUrl(env);
  } catch (err) {
    fail(err.message);
  }
  // A dispatch's credential declaration (it often names the LOCAL dev dashboard) must never reach the hosted one (DX-2483).
  delete env.DANX_DASHBOARD_CREDENTIAL;
  const child = spawn(process.execPath, [ensure.stdout.trim()], { env, stdio: "inherit" });
  child.on("error", (err) => fail(`could not start the dashboard MCP server: ${err.message}`));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runServer();
