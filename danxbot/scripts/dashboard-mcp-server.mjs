#!/usr/bin/env node
// DX-4555: the danx-dashboard MCP server this plugin ships (plugin.json `mcpServers`), so a
// tester who installs the plugin never writes a `.mcp.json`.
//
// WHAT IT RUNS. The installed `@thehammer/danx-dashboard-mcp` (lib/dashboard-mcp-package.mjs installs it, in this
// process, into the plugin data dir; the package's own `dist/index.js` is then run with plain `node`, never a cold
// `npx -y`). Nothing here runs bash or any shell (DX-4235).
//
// WHICH VERSION (DX-4235, DX-5075, DX-5314). Before the server starts, the launcher starts the REFRESH as a DETACHED child
// (`node dashboard-mcp-server.mjs --run-refresh <recorded version>`, node only, no shell) and waits for it up to START_WAIT_MS
// (22 s, under Claude Code's 30 s MCP start limit). The refresh records the registry's `latest` and installs it (an install that
// is already there is skipped), so a session started after a danxbot publish runs that publish. DX-5075: the refresh used to start
// only after the server, so the first session after a publish ran the version the previous refresh had recorded, one release
// behind; 0.1.300 predates the advisory dedupe by id and repeated a stored pacing message three times. When the refresh settles in
// time with a new version, that version runs; when it fails, or is not done in time, the RECORDED version runs. A refresh still
// running at that point goes on in the background: it outlives this launcher (DX-5314: a launcher that exits early no longer kills a
// refresh, which needs several seconds; the record was stuck three versions behind while only short launchers ran), and the running
// server is never restarted. The refresh child installs into its own staging directory and leases the version the launcher ran for as
// long as it runs. A refresh that fails or is stopped appends ONE line to ${CLAUDE_PLUGIN_DATA}/dashboard-mcp/refresh.log (the child holds
// none of the launcher's stdio); the launcher prints that log to its stderr once the start's wait is over, so a failure is never silent.
// Then installs no live process runs are pruned (their own line on failure). The launcher leases the version it runs for as long as
// it runs, so another session's prune never removes it. The launcher exits when the server does, without waiting for a refresh still
// running in the background.
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
import {
  dataDirOf,
  drainRefreshLog,
  installedBin,
  keptLine,
  leaseVersion,
  oneLine,
  pruneInstalls,
  recordedVersionOrNull,
  refreshInstall,
  startVersion,
  appendRefreshLog,
} from "./lib/dashboard-mcp-package.mjs";

const PREFIX = "[danxbot dashboard MCP]";

/** DX-5314: the argument that makes this script the detached refresh child instead of the server launcher. */
export const REFRESH_FLAG = "--run-refresh";
const SELF = fileURLToPath(import.meta.url);

/**
 * DX-5075: how long a start waits for the refresh (the registry check and the install of a newer version) before it starts the recorded
 * one. Under Claude Code's 30 s MCP start limit; a first install after a publish took ~18 s on this machine with three sessions installing
 * at once, so a slower one is finished by the background refresh and adopted at the next start.
 */
export const START_WAIT_MS = 22_000;
/** The tests' seam, like `DASHBOARD_MCP_REGISTRY_TIMEOUT_MS`: bounds the start's wait so a hang test does not wait START_WAIT_MS out. */
export const START_WAIT_ENV = "DASHBOARD_MCP_START_WAIT_MS";

/** The dashboard this session talks to: an explicit DANXBOT_DASHBOARD_URL, else the plugin's configured value. */
export function dashboardUrl(env) {
  const url = env.DANXBOT_DASHBOARD_URL || env.DANXBOT_PLUGIN_DASHBOARD_URL;
  if (!url) throw new Error("no dashboard URL: set DANXBOT_DASHBOARD_URL, or the plugin's dashboard_url option");
  return url;
}

/**
 * DX-5075 + DX-5314: the refresh, run as a detached child started with the recorded version, waited for up to `waitMs`. Resolves `true`
 * when the child recorded a version (exit 0), `false` when it failed, could not start, or was not done in time (it then goes on in the
 * background: unref'd, never stopped here). A failure to start writes its one line to `stderr` now; any other failure's line is in
 * refresh.log, which the caller drains once this has settled.
 */
async function refreshBeforeStart(recorded, { env, spawnFn, stderr, waitMs, timers }) {
  const refreshFailed = (err) => stderr.write(`${PREFIX} ${keptLine(`could not start the refresh: ${oneLine(err.message)}`, recorded)}\n`);
  let child;
  try {
    // ALL its stdio is ignored: it holds no pipe of ours open (the MCP transport may wait for stderr to close).
    child = spawnFn(process.execPath, [SELF, REFRESH_FLAG, recorded], { env, detached: true, stdio: "ignore", windowsHide: true });
  } catch (err) {
    refreshFailed(err);
    return { child: undefined, ok: false };
  }
  const outcome = await new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve(false), waitMs);
    const settle = (value) => {
      timers.clearTimeout(timer);
      resolve(value);
    };
    child.on("exit", (code) => settle(code === 0));
    child.on("error", (err) => {
      refreshFailed(err);
      settle(false);
    });
  });
  child.unref?.();
  return { child, ok: outcome };
}

/**
 * Starts the server on the registry's `latest` when the refresh settles in time (DX-5075), else on the recorded version. `onServer(run)`
 * is called as soon as the server process is spawned, before anything else can happen to it. Returns `run`: `{child, version, release,
 * refreshChild}`. `release` ends the lease on `version` (the exit calls it). `refreshChild` is the detached refresh process (`unref`ed:
 * it outlives this launcher). Throws when the server cannot start (no dashboard URL, no version, a failed install). Seams: `spawnFn`
 * (npm, the server and the refresh child), `fetchFn` (the registry), `stderr`, `startWaitMs` (else START_WAIT_ENV), `timers` ({setTimeout, clearTimeout}: the start's wait, so a test fires it at a chosen moment), and `installVersion`'s
 * `npm` / `installTimeoutMs`.
 */
export async function launch({ env = process.env, spawnFn = spawn, fetchFn = fetch, stderr = process.stderr, onServer = () => {}, startWaitMs, timers = { setTimeout, clearTimeout }, ...installOptions } = {}) {
  const url = dashboardUrl(env);
  const waitMs = startWaitMs ?? (Number(env[START_WAIT_ENV]) > 0 ? Number(env[START_WAIT_ENV]) : START_WAIT_MS);
  const options = { env, spawnFn, fetchFn, ...installOptions };
  // the recorded version, installed (or, with no record, resolved from the registry and recorded): what a start falls back to
  const started = await startVersion(options);
  const { child: refreshChild, ok: refreshed } = await refreshBeforeStart(started.version, { env, spawnFn, stderr, waitMs, timers });
  // DX-5314: what a refresh could not say itself (it holds no stderr of ours) is printed here, after the version is known to start, so a
  // failure is never silent. A refresh still running in the background writes its line later, and the next start prints it.
  try {
    const earlier = drainRefreshLog(env);
    if (earlier !== "") stderr.write(earlier.endsWith("\n") ? earlier : `${earlier}\n`);
  } catch (err) {
    stderr.write(`${PREFIX} could not read the refresh's log (${oneLine(err.message)})\n`);
  }
  // the refresh installs the newer version before it records it, so a recorded version other than the one started is installed
  const latest = refreshed ? recordedVersionOrNull(env) : null;
  const { version, bin } = latest !== null && latest !== started.version ? { version: latest, bin: installedBin(dataDirOf(env), latest) } : started;
  const serverEnv = { ...env, DANXBOT_DASHBOARD_URL: url };
  // A dispatch's credential declaration (it often names the LOCAL dev dashboard) must never reach the hosted one (DX-2483).
  delete serverEnv.DANX_DASHBOARD_CREDENTIAL;
  const release = leaseVersion(version, { env });
  const run = { child: spawnFn(process.execPath, [bin], { env: serverEnv, stdio: "inherit" }), version, release, refreshChild: refreshChild ?? null };
  onServer(run);
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

/**
 * The detached child's whole life: one refresh for `version`, stopped cleanly (npm killed, stage removed, one line) by SIGINT / SIGTERM, then
 * the exit code (0 recorded, 1 failed or stopped). Seams: `proc` (the signal source) and `exit`, plus `runRefresh`'s own.
 */
export async function runRefreshProcess(version, { proc = process, exit = (code) => process.exit(code), env = process.env, ...refreshOptions } = {}) {
  // our stderr is ignored: the failure line is appended to refresh.log, and the next launcher prints it
  const stderr = {
    write: (text) => {
      try {
        appendRefreshLog(text, env);
      } catch {
        // nowhere left to say it
      }
    },
  };
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    stderr.write(`${PREFIX} ${oneLine(`the refresh was started without the running version (${JSON.stringify(version ?? null)})`)}\n`);
    return exit(1);
  }
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) proc.on(sig, () => stop.abort());
  const latest = await runRefresh(version, { ...refreshOptions, env, abort: stop.signal, stderr });
  return exit(latest === null ? 1 : 0);
}

function fail(reason) {
  console.error(`${PREFIX} ${oneLine(reason)}`);
  process.exit(1);
}

/**
 * The server's exit is the launcher's: its code, or 1 when it was killed. The lease is released and the launcher exits at once; a refresh
 * still running in the background is not waited for and not stopped (DX-5314).
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
