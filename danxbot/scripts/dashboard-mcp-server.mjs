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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The dashboard this session talks to: an explicit DANXBOT_DASHBOARD_URL, else the plugin's configured value. */
export function dashboardUrl(env) {
  const url = env.DANXBOT_DASHBOARD_URL || env.DANXBOT_PLUGIN_DASHBOARD_URL;
  if (!url) throw new Error("no dashboard URL: set DANXBOT_DASHBOARD_URL, or the plugin's dashboard_url option");
  return url;
}

/**
 * The bash that runs ensure-dashboard-mcp.sh. Claude Code starts an MCP server WITHOUT a shell, so on Windows a bare
 * `bash` resolves through the Windows PATH, where `C:\Windows\System32\bash.exe` (the WSL launcher) comes first: it
 * cannot read a Windows path and the server never starts (the session gets no dashboard tools). Hooks never hit this,
 * because Claude Code runs hook commands inside Git Bash. So on Windows: Claude Code's own CLAUDE_CODE_GIT_BASH_PATH,
 * else Git for Windows' bash beside `git --exec-path` (`<git>/mingw64/libexec/git-core` -> `<git>/bin/bash.exe`), else
 * a loud failure naming the fix. Anywhere else, `bash` from PATH.
 *
 * @param {string} platform process.platform
 * @param {Record<string, string | undefined>} env
 * @param {() => string | null} getGitExecPath `git --exec-path`, or null when git cannot be run
 * @param {(file: string) => boolean} exists
 */
export function bashFor(platform, env, getGitExecPath, exists) {
  if (platform !== "win32") return "bash";
  // Never the WSL launcher a bare `bash` finds first on the Windows PATH (see the docblock).
  if (env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (exists(env.CLAUDE_CODE_GIT_BASH_PATH)) return env.CLAUDE_CODE_GIT_BASH_PATH;
    throw new Error(`CLAUDE_CODE_GIT_BASH_PATH names ${env.CLAUDE_CODE_GIT_BASH_PATH}, which does not exist`);
  }
  // DX-4623: Windows-only branch; a bare `bash` here is the WSL launcher, so it is never an option.
  const execPath = getGitExecPath();
  if (!execPath) {
    throw new Error(
      "no Git Bash found: `git --exec-path` could not be run (git is not installed or not on PATH); " +
        "install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe " +
        "(the bare `bash` on the Windows PATH is the WSL launcher, which cannot run this plugin's scripts)",
    );
  }
  const candidate = path.win32.join(path.win32.normalize(execPath), "..", "..", "..", "bin", "bash.exe");
  if (exists(candidate)) return candidate;
  throw new Error(
    `no Git Bash found: git runs (exec path ${execPath}) but ${candidate} does not exist; ` +
      "install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe " +
      "(the bare `bash` on the Windows PATH is the WSL launcher, which cannot run this plugin's scripts)",
  );
}

function gitExecPath() {
  const r = spawnSync("git", ["--exec-path"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function fail(reason) {
  console.error(`[danxbot dashboard MCP] ${reason}`);
  process.exit(1);
}

function runServer() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) fail("CLAUDE_PLUGIN_ROOT is not set: this launcher only runs as the danxbot plugin's MCP server");
  let bash;
  try {
    bash = bashFor(process.platform, process.env, gitExecPath, existsSync);
  } catch (err) {
    fail(err.message);
  }
  const ensure = spawnSync(bash, [path.join(root, "scripts", "ensure-dashboard-mcp.sh")], {
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
