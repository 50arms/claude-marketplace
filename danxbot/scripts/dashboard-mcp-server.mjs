#!/usr/bin/env node
// DX-4555: the danx-dashboard MCP server this plugin ships (plugin.json `mcpServers`), so a
// tester who installs the plugin never writes a `.mcp.json`.
//
// WHAT IT RUNS. The installed `@thehammer/danx-dashboard-mcp` (lib/dashboard-mcp-package.mjs installs it, in this
// process, into the plugin data dir; the package's own `dist/index.js` is then run with plain `node`, never a cold
// `npx -y`). Nothing here runs bash or any shell (DX-4235).
//
// WHICH VERSION (DX-4235). The server starts at once from the RECORDED version (installed first if it is not; resolved
// from the registry and recorded only when nothing is recorded). While it runs, the record is refreshed from the
// registry's `latest` and that version installed in the background, never restarting the running server, so a publish
// is adopted at the next session start with no added start latency. A refresh that fails writes ONE line to stderr and
// the record stays as it was. Then installs no live process runs are pruned (their own line on failure). The launcher
// leases the version it runs for as long as it runs, so another session's prune never removes it. When the server exits
// mid-refresh, npm is killed and its stage removed before the launcher exits (bounded by REFRESH_STOP_MS).
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
// stdout is the MCP stream, so nothing here may print to it: every notice goes to stderr, and npm's output is captured.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keptLine, leaseVersion, oneLine, pruneInstalls, refreshInstall, startVersion } from "./lib/dashboard-mcp-package.mjs";

const PREFIX = "[danxbot dashboard MCP]";

/** DX-4235: how long an exiting launcher waits for a stopped refresh to kill npm and remove its stage. */
export const REFRESH_STOP_MS = 5_000;

/** The dashboard this session talks to: an explicit DANXBOT_DASHBOARD_URL, else the plugin's configured value. */
export function dashboardUrl(env) {
  const url = env.DANXBOT_DASHBOARD_URL || env.DANXBOT_PLUGIN_DASHBOARD_URL;
  if (!url) throw new Error("no dashboard URL: set DANXBOT_DASHBOARD_URL, or the plugin's dashboard_url option");
  return url;
}

/**
 * Starts the server and, once it is running, the background refresh and then the prune. `onServer(run)` is called as soon
 * as the server process is spawned, before anything else can happen to it. Returns `run`: `{child, version, release, refresh,
 * stopRefresh}`. `release` ends the lease on `version` (the exit calls it). `refresh` settles with the version it recorded, or
 * `null` after writing its one failure line to `stderr` (none when `stopRefresh` stopped it). Throws when the server cannot
 * start (no dashboard URL, no version, a failed install). Seams: `spawnFn` (npm and the server), `fetchFn` (the registry),
 * `now` and `alive` (the prune), and `installVersion`'s `npm` / `installTimeoutMs`.
 */
export async function launch({ env = process.env, spawnFn = spawn, fetchFn = fetch, stderr = process.stderr, onServer = () => {}, now, alive, ...installOptions } = {}) {
  const url = dashboardUrl(env);
  const stop = new AbortController();
  const options = { env, spawnFn, fetchFn, abort: stop.signal, ...installOptions };
  const { version, bin } = await startVersion(options);
  const serverEnv = { ...env, DANXBOT_DASHBOARD_URL: url };
  // A dispatch's credential declaration (it often names the LOCAL dev dashboard) must never reach the hosted one (DX-2483).
  delete serverEnv.DANX_DASHBOARD_CREDENTIAL;
  const release = leaseVersion(version, { env });
  const run = { child: spawnFn(process.execPath, [bin], { env: serverEnv, stdio: "inherit" }), version, release, refresh: null, stopRefresh: () => stop.abort() };
  onServer(run);
  // DX-4235: the refresh starts only after the server has, so no registry request delays a session start.
  run.refresh = refreshInstall(options).then(
    (latest) => {
      try {
        // an option left undefined takes pruneInstalls' own default
        pruneInstalls([version, latest], { env, now, alive });
      } catch (err) {
        stderr.write(`${PREFIX} could not prune old installs (${oneLine(err.message)}); they stay until a later refresh prunes them\n`);
      }
      return latest;
    },
    (err) => {
      if (stop.signal.aborted) return null;
      stderr.write(`${PREFIX} ${keptLine(oneLine(err.message), version)}\n`);
      return null;
    },
  );
  return run;
}

function fail(reason) {
  console.error(`${PREFIX} ${oneLine(reason)}`);
  process.exit(1);
}

/**
 * The server's exit is the launcher's: its code, or 1 when it was killed. A refresh still running is stopped first (npm
 * killed, its stage removed), waited for at most REFRESH_STOP_MS, and the lease is released.
 */
function wireServer(run) {
  const { child } = run;
  child.on("error", (err) => fail(`could not start the dashboard MCP server: ${err.message}`));
  child.on("exit", (code, signal) => {
    run.stopRefresh();
    const bound = new Promise((resolve) => setTimeout(resolve, REFRESH_STOP_MS));
    void Promise.race([run.refresh, bound]).then(() => {
      run.release();
      process.exit(signal ? 1 : (code ?? 1));
    });
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

async function runServer() {
  try {
    await launch({ onServer: wireServer });
  } catch (err) {
    fail(err.message);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await runServer();
