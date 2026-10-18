#!/usr/bin/env node
// DX-4555: the danx-dashboard MCP server this plugin ships (plugin.json `mcpServers`), so a
// tester who installs the plugin never writes a `.mcp.json`.
//
// WHAT IT RUNS. The installed `@thehammer/danx-dashboard-mcp` (lib/dashboard-mcp-package.mjs installs it, in this
// process, into the plugin data dir; the package's own `dist/index.js` is then run with plain `node`, never a cold
// `npx -y`). Nothing here runs bash or any shell (DX-4235).
//
// WHICH VERSION (DX-4235, DX-5314). The server starts at once from the RECORDED version (installed first if it is not; resolved
// from the registry and recorded only when nothing is recorded). Right after, the launcher starts the REFRESH as a DETACHED child
// (`node dashboard-mcp-server.mjs --run-refresh <version>`, node only, no shell) that outlives the launcher: it records the registry's
// `latest` and installs that version, never restarting the running server, so a publish is adopted at the next session start with
// no added start latency. A launcher that exits early (a probe, a session that ends within seconds) no longer kills a refresh, which
// needs several seconds: DX-5314 found the record stuck three versions behind because every launcher since the last full refresh was
// short-lived. The refresh child installs into its own staging directory (installVersion makes a fresh one per install) and leases the
// version the launcher ran for as long as it runs. A refresh that fails or is stopped appends ONE line to ${CLAUDE_PLUGIN_DATA}/dashboard-mcp/refresh.log (the child holds none of the launcher's stdio) that the next launcher prints to its stderr, and the record stays
// as it was. Then installs no live process runs are pruned (their own line on failure). The launcher leases the version it runs for
// as long as it runs, so another session's prune never removes it. The launcher exits when the server does, without waiting for the
// refresh.
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
import { appendRefreshLog, drainRefreshLog, keptLine, leaseVersion, oneLine, pruneInstalls, refreshInstall, startVersion } from "./lib/dashboard-mcp-package.mjs";

const PREFIX = "[danxbot dashboard MCP]";

/** DX-5314: the argument that makes this script the detached refresh child instead of the server launcher. */
export const REFRESH_FLAG = "--run-refresh";
const SELF = fileURLToPath(import.meta.url);

/** The dashboard this session talks to: an explicit DANXBOT_DASHBOARD_URL, else the plugin's configured value. */
export function dashboardUrl(env) {
  const url = env.DANXBOT_DASHBOARD_URL || env.DANXBOT_PLUGIN_DASHBOARD_URL;
  if (!url) throw new Error("no dashboard URL: set DANXBOT_DASHBOARD_URL, or the plugin's dashboard_url option");
  return url;
}

/**
 * Starts the server and, once it is running, the detached refresh child. `onServer(run)` is called as soon as the server process is
 * spawned, before anything else can happen to it. Returns `run`: `{child, version, release, refreshChild}`. `release` ends the lease
 * on `version` (the exit calls it). `refreshChild` is the detached refresh process (`unref`ed: it outlives this one); a refresh that
 * cannot even start writes its one line to `stderr`. Throws when the server cannot start (no dashboard URL, no version, a failed
 * install). Seams: `spawnFn` (npm, the server and the refresh child), `fetchFn` (the registry, for a start with no record), and
 * `installVersion`'s `npm` / `installTimeoutMs`.
 */
export async function launch({ env = process.env, spawnFn = spawn, fetchFn = fetch, stderr = process.stderr, onServer = () => {}, ...installOptions } = {}) {
  const url = dashboardUrl(env);
  const options = { env, spawnFn, fetchFn, ...installOptions };
  const { version, bin } = await startVersion(options);
  // DX-5314: what the detached refresh of an earlier launcher could not say (it holds no stderr of ours) surfaces here, at the next start (after the version is known to start, so a launcher that cannot start says only why), so a failure is never silent.
  try {
    const earlier = drainRefreshLog(env);
    if (earlier !== "") stderr.write(earlier.endsWith("\n") ? earlier : `${earlier}\n`);
  } catch (err) {
    stderr.write(`${PREFIX} could not read the earlier refresh's log (${oneLine(err.message)})\n`);
  }
  const serverEnv = { ...env, DANXBOT_DASHBOARD_URL: url };
  // A dispatch's credential declaration (it often names the LOCAL dev dashboard) must never reach the hosted one (DX-2483).
  delete serverEnv.DANX_DASHBOARD_CREDENTIAL;
  const release = leaseVersion(version, { env });
  const run = { child: spawnFn(process.execPath, [bin], { env: serverEnv, stdio: "inherit" }), version, release, refreshChild: null };
  onServer(run);
  // DX-4235: the refresh starts only after the server has, so no registry request delays a session start.
  // DX-5314: detached, so it finishes when this launcher exits first. ALL its stdio is ignored: it holds no pipe of ours open (the MCP transport may wait for stderr to close). Its one failure line goes to refresh.log; the next launcher prints it.
  const refreshFailed = (err) => stderr.write(`${PREFIX} ${keptLine(`could not start the refresh: ${oneLine(err.message)}`, version)}\n`);
  try {
    run.refreshChild = spawnFn(process.execPath, [SELF, REFRESH_FLAG, version], { env, detached: true, stdio: "ignore", windowsHide: true });
    run.refreshChild.on?.("error", refreshFailed);
    run.refreshChild.unref?.();
  } catch (err) {
    refreshFailed(err);
  }
  return run;
}

/**
 * DX-5314: the refresh, run by the detached child (and by the tests directly). Leases `version` (the one the launcher ran) while it
 * runs, records and installs the registry's `latest`, then prunes old installs. Settles with the version it recorded, or `null` after
 * writing its ONE failure line to `stderr`: a failed, timed-out or stopped (`abort`) refresh is never silent. The prune's own failure
 * is its own line and never a failed refresh. Seams: as `launch`, plus `now` and `alive` (the prune).
 */
export async function runRefresh(version, { env = process.env, stderr = process.stderr, now, alive, ...installOptions } = {}) {
  const options = { env, ...installOptions };
  let release = () => {};
  try {
    release = leaseVersion(version, { env });
    const latest = await refreshInstall(options);
    try {
      // an option left undefined takes pruneInstalls' own default
      pruneInstalls([version, latest], { env, now, alive });
    } catch (err) {
      stderr.write(`${PREFIX} could not prune old installs (${oneLine(err.message)}); they stay until a later refresh prunes them\n`);
    }
    return latest;
  } catch (err) {
    stderr.write(`${PREFIX} ${keptLine(oneLine(err.message), version)}\n`);
    return null;
  } finally {
    release();
  }
}

/** The detached child's whole life: one refresh for `version`, stopped cleanly (npm killed, stage removed, one line) by SIGINT / SIGTERM. */
async function runRefreshProcess(version) {
  // our stderr is ignored: the failure line is appended to refresh.log, and the next launcher prints it
  const stderr = {
    write: (text) => {
      try {
        appendRefreshLog(text);
      } catch {
        // nowhere left to say it
      }
    },
  };
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    stderr.write(`${PREFIX} ${oneLine(`the refresh was started without the running version (${JSON.stringify(version ?? null)})`)}\n`);
    process.exit(1);
  }
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop.abort());
  const latest = await runRefresh(version, { abort: stop.signal, stderr });
  process.exit(latest === null ? 1 : 0);
}

function fail(reason) {
  console.error(`${PREFIX} ${oneLine(reason)}`);
  process.exit(1);
}

/**
 * The server's exit is the launcher's: its code, or 1 when it was killed. The lease is released and the launcher exits at once; the
 * detached refresh child is not waited for and not stopped (DX-5314).
 */
function wireServer(run) {
  const { child } = run;
  child.on("error", (err) => fail(`could not start the dashboard MCP server: ${err.message}`));
  child.on("exit", (code, signal) => {
    run.release();
    process.exit(signal ? 1 : (code ?? 1));
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

if (process.argv[1] && SELF === path.resolve(process.argv[1])) {
  if (process.argv[2] === REFRESH_FLAG) await runRefreshProcess(process.argv[3]);
  else await runServer();
}
