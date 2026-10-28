#!/usr/bin/env node
// the danx-dashboard MCP server this plugin ships (plugin.json `mcpServers`), so a
// tester who installs the plugin never writes a `.mcp.json`.
//
// WHAT IT RUNS. The installed `@thehammer/danx-dashboard-mcp` (lib/dashboard-mcp-package.mjs installs it, in this
// process, into the plugin data dir; the package's own built entry point is then run with plain `node`, never a cold
// `npx -y`). Nothing here runs bash or any shell.
//
// WHICH VERSION. Before the server starts, the launcher starts the REFRESH as a DETACHED child
// (`node dashboard-mcp-server.mjs --run-refresh <recorded version>`, node only, no shell) and waits for it up to START_WAIT_MS
// (22 s, under Claude Code's 30 s MCP start limit). The refresh records the registry's `latest` and installs it (an install that
// is already there is skipped), so a session started after a danxbot publish runs that publish. The refresh used to start
// only after the server, so the first session after a publish ran the version the previous refresh had recorded, one release
// behind; 0.1.300 predates the advisory dedupe by id and repeated a stored pacing message three times. When the refresh settles in
// time with a new version, that version runs; when it fails, or is not done in time, the RECORDED version runs. A refresh still
// running at that point goes on in the background: it outlives this launcher (a launcher that exits early no longer kills a
// refresh, which needs several seconds; the record was stuck three versions behind while only short launchers ran), and the running
// server is never restarted. The refresh child installs into its own staging directory and leases the version the launcher ran for as
// long as it runs. A refresh that fails or is stopped appends ONE line to ${CLAUDE_PLUGIN_DATA}/dashboard-mcp/refresh.log (the child holds
// none of the launcher's stdio); the launcher prints that log to its stderr once the start's wait is over, so a failure is never silent.
// Then installs no live process runs are pruned (their own line on failure). The launcher leases the version it runs for as long as
// it runs, so another session's prune never removes it. The launcher exits when the server does, without waiting for a refresh still
// running in the background.
//
// WHICH DASHBOARD (`dashboardUrl`, chosen PER SESSION FOLDER, never machine-wide). The folder's own
// `.claude/settings.local.json` (gitignored: the session's own switch) or `.claude/settings.json` `env.DANXBOT_DASHBOARD_URL`
// names the dashboard. With none, a DANXBOT_DASHBOARD_URL in the shell or a user setting is REFUSED (it would move every session
// at once), and the plugin's `userConfig.dashboard_url` (passed as DANXBOT_PLUGIN_DASHBOARD_URL; its default is the hosted
// dashboard) is used. DANX_REPO_NAME / DANXBOT_BOARD_NAME stay unset: the session names its board per call (the `board` argument)
// or through `plan_connect`.
//
// The ONE dashboard server: no connected repo declares its own `danx-dashboard` entry any more, so Claude
// Code lists exactly this one, named `plugin:danxbot:danx-dashboard`, in every folder.
//
// stdout is the MCP stream, so nothing here may print to it: every notice goes to stderr, and npm's output is captured.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** the argument that makes this script the detached refresh child instead of the server launcher. */
export const REFRESH_FLAG = "--run-refresh";
const SELF = fileURLToPath(import.meta.url);

/**
 * how long a start waits for the refresh (the registry check and the install of a newer version) before it starts the recorded
 * one. Under Claude Code's 30 s MCP start limit; a first install after a publish took ~18 s on this machine with three sessions installing
 * at once, so a slower one is finished by the background refresh and adopted at the next start.
 */
export const START_WAIT_MS = 22_000;
/** The tests' seam, like `DASHBOARD_MCP_REGISTRY_TIMEOUT_MS`: bounds the start's wait so a hang test does not wait START_WAIT_MS out. */
export const START_WAIT_ENV = "DASHBOARD_MCP_START_WAIT_MS";

/** The per-folder settings files a session's dashboard can be named in: the gitignored local one wins over the committed one. */
export const FOLDER_SETTINGS_FILES = [".claude/settings.local.json", ".claude/settings.json"];
/**
 * DEC-77: the marker a local-dashboard session folder carries (`.claude/worktrees/local-dashboard`, written by
 * `make local-dashboard-session` in the operator checkout). The launcher refuses a marked folder whose settings name no URL, so a
 * session meant for the local dashboard can never fall back to the hosted default.
 */
// MIRROR of the marker contract owned by the danxbot repo (src/machine-clean/local-dashboard-folder.ts, rule .claude/rules/dashboard-api-access.md).
// Change them there first, then here.
export const LOCAL_DASHBOARD_MARKER_REL = ".claude/local-dashboard.json";
export const LOCAL_DASHBOARD_MARKER_SCHEMA = 1;

/**
 * The dashboard named by this folder's own settings (`env.DANXBOT_DASHBOARD_URL` in `.claude/settings.local.json`, then
 * `.claude/settings.json`) and the file that names it, or undefined when neither names one. A settings file that is unreadable,
 * not JSON, or names a URL that is not http(s) fails loudly: a session never silently falls back to another dashboard.
 */
export function folderDashboard(projectDir) {
  for (const rel of FOLDER_SETTINGS_FILES) {
    const file = path.join(projectDir, rel);
    if (!existsSync(file)) continue;
    let settings;
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} is not readable JSON (${err.message}): fix it, or remove its DANXBOT_DASHBOARD_URL`);
    }
    const url = settings?.env?.DANXBOT_DASHBOARD_URL;
    if (url === undefined) continue;
    if (!isHttpUrl(url)) throw new Error(`${file} env.DANXBOT_DASHBOARD_URL is not an http(s) URL: ${JSON.stringify(url)}`);
    return { url, file };
  }
  return undefined;
}

/** The URL the folder's settings name, or undefined (see `folderDashboard`). */
export function folderDashboardUrl(projectDir) {
  return folderDashboard(projectDir)?.url;
}

/** The folder's local-dashboard marker (DEC-77), or undefined when the folder carries none. A marker of another shape fails loudly. */
export function localDashboardMarker(projectDir) {
  const file = path.join(projectDir, LOCAL_DASHBOARD_MARKER_REL);
  if (!existsSync(file)) return undefined;
  let marker;
  try {
    marker = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not readable JSON (${err.message}): fix it, or remove it and re-run make local-dashboard-session`);
  }
  if (marker?.schema !== LOCAL_DASHBOARD_MARKER_SCHEMA || !isHttpUrl(marker?.url)) {
    throw new Error(`${file} is not a schema-${LOCAL_DASHBOARD_MARKER_SCHEMA} local-dashboard marker with an http(s) url: fix it, or re-run make local-dashboard-session`);
  }
  return { url: marker.url, file };
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The dashboard this session talks to, chosen per session folder, never machine-wide:
 *  1. the folder's own `.claude/settings.local.json` / `.claude/settings.json` `env.DANXBOT_DASHBOARD_URL` (Claude Code
 *     merges these into the environment, so this is the value the folder names);
 *  2. the plugin's `dashboard_url` option, the hosted default, which is the only machine-wide value and is the production dashboard;
 *  3. a DANXBOT_DASHBOARD_URL that reached the environment WITHOUT a folder naming it came from the shell or a user-level
 *     setting: one naming a dashboard other than the plugin's option would move every session on the machine at once, so it is
 *     refused, naming the folder file to use instead. One naming the same dashboard moves nothing and is accepted (DX-6392: this
 *     machine's Windows user environment carries the hosted URL, inherited by every session).
 */
export function dashboardChoice(env, projectDir = env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const marker = localDashboardMarker(projectDir);
  const folder = folderDashboard(projectDir);
  if (marker !== undefined) {
    // DEC-77: a marked local-dashboard folder is never the hosted default: its settings must name the URL its marker names.
    const settingsFile = path.join(projectDir, ".claude", "settings.local.json");
    if (folder === undefined) {
      throw new Error(`${marker.file} marks this folder as a local-dashboard session, but ${settingsFile} names no env.DANXBOT_DASHBOARD_URL: refusing to start on the hosted default (DEC-73). Re-run make local-dashboard-session`);
    }
    if (!sameDashboard(marker.url, folder.url)) {
      throw new Error(`${folder.file} names ${folder.url}, but ${marker.file} names ${marker.url}: they must agree; re-run make local-dashboard-session`);
    }
    return { url: folder.url, source: `${folder.file} (marked local-dashboard session)`, kind: "folder" };
  }
  if (folder !== undefined) return { url: folder.url, source: folder.file, kind: "folder" };
  const url = env.DANXBOT_PLUGIN_DASHBOARD_URL;
  if (!url) throw new Error("no dashboard URL: name one in this folder's .claude/settings.local.json env (DANXBOT_DASHBOARD_URL), or set the plugin's dashboard_url option");
  if (!isHttpUrl(url)) throw new Error(`the plugin's dashboard_url option is not an http(s) URL: ${JSON.stringify(url)}`);
  if (env.DANXBOT_DASHBOARD_URL && !sameDashboard(env.DANXBOT_DASHBOARD_URL, url)) {
    throw new Error(`DANXBOT_DASHBOARD_URL=${env.DANXBOT_DASHBOARD_URL} is set in the shell or a user setting, which moves every session at once: name this folder's dashboard in ${path.join(projectDir, ".claude", "settings.local.json")} under env instead`);
  }
  return { url, source: "the plugin's dashboard_url option (hosted default)", kind: "plugin-option" };
}

/** The URL this session talks to (see `dashboardChoice`). */
export function dashboardUrl(env, projectDir = env.CLAUDE_PROJECT_DIR || process.cwd()) {
  return dashboardChoice(env, projectDir).url;
}

/** Whether two dashboard URLs name the same origin (scheme, host, port); a trailing slash or path never makes them differ. */
function sameDashboard(a, b) {
  if (!isHttpUrl(a)) return false;
  return new URL(a).origin === new URL(b).origin;
}

/**
 * the refresh, run as a detached child started with the recorded version, waited for up to `waitMs`. Resolves `true`
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
 * Starts the server on the registry's `latest` when the refresh settles in time, else on the recorded version. `onServer(run)`
 * is called as soon as the server process is spawned, before anything else can happen to it. Returns `run`: `{child, version, release,
 * refreshChild}`. `release` ends the lease on `version` (the exit calls it). `refreshChild` is the detached refresh process (`unref`ed:
 * it outlives this launcher). Throws when the server cannot start (no dashboard URL, no version, a failed install). Seams: `spawnFn`
 * (npm, the server and the refresh child), `fetchFn` (the registry), `stderr`, `startWaitMs` (else START_WAIT_ENV), `timers` ({setTimeout, clearTimeout}: the start's wait, so a test fires it at a chosen moment), and `installVersion`'s
 * `npm` / `installTimeoutMs`.
 */
export async function launch({ env = process.env, spawnFn = spawn, fetchFn = fetch, stderr = process.stderr, onServer = () => {}, startWaitMs, timers = { setTimeout, clearTimeout }, ...installOptions } = {}) {
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const choice = dashboardChoice(env, projectDir);
  const { url, source } = choice;
  // DEC-73: the hosted default is never chosen by guessing the folder. Claude Code always sets CLAUDE_PROJECT_DIR for a plugin's MCP
  // server; without it the launcher cannot tell which session folder this is, so it refuses rather than fall back to hosted.
  if (choice.kind === "plugin-option" && !env.CLAUDE_PROJECT_DIR) {
    throw new Error(`CLAUDE_PROJECT_DIR is unset, so this launcher cannot tell which session folder it serves, and refuses the hosted default (${url}). Claude Code sets it for every plugin MCP server: start the session through Claude Code, or set CLAUDE_PROJECT_DIR`);
  }
  // Which folder file (or the plugin option) decided the dashboard. Only with DANXBOT_DASHBOARD_TRACE set: a start's stderr is
  // otherwise empty or one line (DX-5314), and a trace must not break that.
  if (env.DANXBOT_DASHBOARD_TRACE) stderr.write(`${PREFIX} dashboard ${url} from ${source}; project dir ${projectDir} (from ${env.CLAUDE_PROJECT_DIR ? "CLAUDE_PROJECT_DIR" : "the working directory"})
`);
  const waitMs = startWaitMs ?? (Number(env[START_WAIT_ENV]) > 0 ? Number(env[START_WAIT_ENV]) : START_WAIT_MS);
  const options = { env, spawnFn, fetchFn, ...installOptions };
  // the recorded version, installed (or, with no record, resolved from the registry and recorded): what a start falls back to
  const started = await startVersion(options);
  const { child: refreshChild, ok: refreshed } = await refreshBeforeStart(started.version, { env, spawnFn, stderr, waitMs, timers });
  // what a refresh could not say itself (it holds no stderr of ours) is printed here, after the version is known to start, so a
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
  // A dispatch's credential declaration (it often names the LOCAL dev dashboard) must never reach the hosted one.
  delete serverEnv.DANX_DASHBOARD_CREDENTIAL;
  const release = leaseVersion(version, { env });
  const run = { child: spawnFn(process.execPath, [bin], { env: serverEnv, stdio: "inherit" }), version, release, refreshChild: refreshChild ?? null };
  onServer(run);
  return run;
}

/**
 * the refresh, run by the detached child (and by the tests directly). Leases `version` (the one the launcher ran) while it
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
 * still running in the background is not waited for and not stopped.
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
