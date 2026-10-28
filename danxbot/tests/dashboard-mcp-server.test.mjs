import "./designated-test-container.mjs";
// dashboard-mcp-server.mjs (DX-4555, DX-4578, DX-4235): the MCP server the plugin ships, the one dashboard server of every
// session. It refreshes the record before it starts the server (DX-5075), waiting a bounded time, and falls back to the recorded version. A fake
// registry (fixtures/fake-registry.mjs) stands in for npm's registry and an injected spawn for npm and the server; the
// end-to-end cases run the real launcher process (and, DX-5314, its real detached refresh child, with fixtures/fake-npm-cli.mjs
// standing in for npm) against a pre-installed fake package. Nothing here touches the network.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_MCP_PACKAGE_NAME, NPM_CLI_ENV, appendRefreshLog, drainRefreshLog, refreshLogFile, STALE_INSTALL_MS, installedBin, leaseVersion, recordedVersionOrNull, writeRecordedVersion } from "../scripts/lib/dashboard-mcp-package.mjs";
import { REFRESH_FLAG, START_WAIT_ENV, START_WAIT_MS, dashboardUrl, launch, runRefresh, runRefreshProcess } from "../scripts/dashboard-mcp-server.mjs";
import { REGISTRY_BASE_URL_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const LAUNCHER = path.join(PLUGIN_ROOT, "scripts", "dashboard-mcp-server.mjs");
const FAKE_NPM = path.join(here, "fixtures", "fake-npm-cli.mjs");
const A = "0.1.7";
const B = "0.1.8";
const NPM = { command: "npm", args: [] };

let dataDir;
let registry;
let env;
const folders = [];
/** A session folder; `settings` (when given) is written to its `.claude/settings.local.json`. */
function sessionFolder(settings) {
  const dir = mkdtempSync(path.join(tmpdir(), "dash-mcp-folder-"));
  folders.push(dir);
  if (settings !== undefined) {
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify(settings));
  }
  return dir;
}
beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dash-mcp-data-"));
  registry = await startFakeRegistry({ version: A });
  env = { CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: sessionFolder({ env: { DANXBOT_DASHBOARD_URL: "https://dash.example" } }), [REGISTRY_BASE_URL_ENV]: registry.url };
});
afterEach(async () => {
  await registry.stop();
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Records `version` the way the launcher does. */
const recordAt = (version) => writeRecordedVersion(version, { CLAUDE_PLUGIN_DATA: dataDir });

/** Puts a stand-in entry point where `version`'s install lives. */
function layDown(version) {
  const bin = installedBin(dataDir, version);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, `installed ${version}`);
  return bin;
}

/**
 * The launcher's seams: one `spawnFn` for npm (an `install` lays the package down under its --prefix, or fails with
 * `npmMode: "fail"`, or runs until killed with `npmMode: "hang"`) and the server (a child that runs until killed), one
 * `fetchFn` passing to the fake registry, and a
 * `stderr`. Every spawn and registry request lands in `timeline`, in order.
 */
function harness({ npmMode = "ok" } = {}) {
  const timeline = [];
  const spawns = [];
  const servers = [];
  const npms = [];
  const refreshes = [];
  const errLines = [];
  const spawnFn = (command, args, options) => {
    spawns.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => (child.killed = true);
    if (args[1] === REFRESH_FLAG) {
      // DX-5314 / DX-5075: the detached refresh child, run in this process with the harness's seams; its exit is the child's exit
      timeline.push(`refresh ${args[2]}`);
      child.unref = () => (child.unrefed = true);
      const proc = new EventEmitter();
      const done = new Promise((resolve) => {
        setImmediate(() =>
          runRefreshProcess(args[2], {
            env: options.env,
            fetchFn,
            spawnFn,
            npm: NPM,
            proc,
            exit: (code) => {
              child.emit("exit", code, null);
              resolve(code);
            },
          }),
        );
      });
      refreshes.push({ command, args, options, child, proc, done });
    } else if (args.includes("install")) {
      const spec = args.at(-1);
      timeline.push(`npm install ${spec}`);
      const prefix = args[args.indexOf("--prefix") + 1];
      npms.push(child);
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit("close", null, "SIGTERM"));
      };
      setImmediate(() => {
        if (npmMode === "hang") return;
        if (npmMode === "fail") {
          child.stderr.emit("data", "npm error 404 Not Found\n");
          return child.emit("close", 1, null);
        }
        const bin = path.join(prefix, "node_modules", ...DASHBOARD_MCP_PACKAGE_NAME.split("/"), "dist", "index.js");
        mkdirSync(path.dirname(bin), { recursive: true });
        writeFileSync(bin, `installed ${spec}`);
        child.emit("close", 0, null);
      });
    } else {
      timeline.push(`server ${path.relative(dataDir, args[0]).split(path.sep)[1]}`);
      servers.push({ child, options });
    }
    return child;
  };
  const fetchFn = (url, init) => {
    timeline.push("registry request");
    return fetch(url, init);
  };
  const stderr = { write: (text) => errLines.push(text) };
  return { timeline, spawns, servers, npms, refreshes, errLines, options: { env, spawnFn, fetchFn, stderr, npm: NPM } };
}

describe("dashboardUrl: chosen per session folder, never machine-wide", () => {
  test("the folder's settings.local.json names the dashboard, beating the committed settings.json and the shell", () => {
    const folder = sessionFolder({ env: { DANXBOT_DASHBOARD_URL: "http://localhost:5555" } });
    writeFileSync(path.join(folder, ".claude", "settings.json"), JSON.stringify({ env: { DANXBOT_DASHBOARD_URL: "https://committed" } }));
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "https://shell" }, folder), "http://localhost:5555");
  });

  test("the committed settings.json names the dashboard when the local file does not", () => {
    const folder = sessionFolder();
    mkdirSync(path.join(folder, ".claude"), { recursive: true });
    writeFileSync(path.join(folder, ".claude", "settings.json"), JSON.stringify({ env: { DANXBOT_DASHBOARD_URL: "https://committed" } }));
    assert.equal(dashboardUrl({}, folder), "https://committed");
  });

  test("a DANXBOT_DASHBOARD_URL from the shell or a user setting, with no folder naming one, is refused: it would move every session", () => {
    assert.throws(() => dashboardUrl({ DANXBOT_DASHBOARD_URL: "http://localhost:5555" }, sessionFolder()), /moves every session at once.*settings\.local\.json/);
  });

  test("with no folder and no shell value, the plugin's dashboard_url option (the hosted default) is used", () => {
    assert.equal(dashboardUrl({ DANXBOT_PLUGIN_DASHBOARD_URL: "https://hosted" }, sessionFolder()), "https://hosted");
  });

  test("nothing configured fails loudly", () => {
    assert.throws(() => dashboardUrl({}, sessionFolder()), /no dashboard URL/);
  });

  test("a settings file that is not JSON, or names a URL that is not http(s), fails loudly and never falls through to another dashboard", () => {
    const broken = sessionFolder();
    mkdirSync(path.join(broken, ".claude"), { recursive: true });
    writeFileSync(path.join(broken, ".claude", "settings.local.json"), "{ not json");
    assert.throws(() => dashboardUrl({ DANXBOT_PLUGIN_DASHBOARD_URL: "https://hosted" }, broken), /not readable JSON/);
    assert.throws(() => dashboardUrl({}, sessionFolder({ env: { DANXBOT_DASHBOARD_URL: "localhost:5555" } })), /not an http\(s\) URL/);
  });
});

describe("launch: the version the server starts from (DX-4235)", () => {
  test("DX-5075: the refresh settles before the server starts; an installed latest that is already recorded starts at once", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    const { child, version } = await launch(h.options);
    assert.equal(version, A);
    assert.deepEqual(h.timeline, [`refresh ${A}`, "registry request", `server ${A}`], "the refresh settles before the server starts");
    assert.equal(child.killed, false);
  });

  test("a recorded version that is not installed is installed first, then the refresh settles, then the server starts", async () => {
    recordAt(A);
    const h = harness();
    await launch(h.options);
    assert.deepEqual(h.timeline, [`npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${A}`, `refresh ${A}`, "registry request", `server ${A}`]);
  });

  test("with no record it resolves from the registry first, installs and records that version, then starts the server", async () => {
    const h = harness();
    const { version } = await launch(h.options);
    assert.equal(version, A);
    assert.equal(recordedVersionOrNull(env), A);
    assert.deepEqual(h.timeline, ["registry request", `npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${A}`, `refresh ${A}`, "registry request", `server ${A}`]);
  });

  test("DX-5314: the refresh is a DETACHED node child that outlives the launcher, started before the server, with no shell", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    await launch(h.options);
    assert.equal(h.refreshes.length, 1);
    const [{ command, args, options, child }] = h.refreshes;
    assert.equal(command, process.execPath, "this node, not a shell");
    assert.deepEqual(args, [LAUNCHER, REFRESH_FLAG, A]);
    assert.equal(options.detached, true);
    assert.equal(options.shell, undefined);
    assert.equal(options.stdio, "ignore", "it holds none of the launcher's pipes open: its failure line goes to refresh.log");
    assert.equal(options.env.CLAUDE_PLUGIN_DATA, dataDir);
    assert.equal(child.unrefed, true, "the launcher does not wait for it");
  });

  test("DX-5075: a session started after a publish runs the publish: the latest is installed and recorded BEFORE the server starts", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness();
    const { child, version } = await launch(h.options);
    assert.equal(version, B, "the release, not the version the previous refresh recorded");
    assert.equal(recordedVersionOrNull(env), B);
    assert.ok(existsSync(installedBin(dataDir, B)));
    assert.deepEqual(h.timeline, [`refresh ${A}`, "registry request", `npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${B}`, `server ${B}`]);
    assert.equal(h.servers.length, 1);
    assert.equal(child.killed, false);
    assert.deepEqual(h.errLines, []);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", B, ".leases")), [String(process.pid)], "the lease is on the version it runs");

    const next = harness();
    await launch(next.options);
    assert.deepEqual(next.timeline, [`refresh ${B}`, "registry request", `server ${B}`], "the next start installs nothing");
  });

  test("DX-5075: an install not done within the start's wait starts the recorded version, and the install goes on in the background", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "hang" });
    // the wait's timer is the test's: it fires only once the hanging install has been spawned, never by the clock
    let expire;
    const timers = { setTimeout: (fn) => (expire = fn), clearTimeout: () => {} };
    const launching = launch({ ...h.options, timers });
    while (h.npms.length === 0 || expire === undefined) await new Promise((resolve) => setImmediate(resolve));
    expire();
    const run = await launching;
    assert.equal(run.version, A);
    assert.deepEqual(h.timeline, [`refresh ${A}`, "registry request", `npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${B}`, `server ${A}`]);
    assert.equal(h.npms[0].killed, false, "the install is not abandoned");
    assert.equal(h.refreshes[0].child.killed, false, "the refresh child the launcher could kill is left running");
    assert.equal(run.refreshChild.unrefed, true, "the launcher does not wait for the refresh");
    h.refreshes[0].proc.emit("SIGTERM");
    assert.equal(await h.refreshes[0].done, 1, "stopped: the refresh records nothing");
    assert.equal(recordedVersionOrNull(env), A);
    run.release();
  });

  test("DX-5075: START_WAIT_MS stays under Claude Code's 30 s MCP start limit, and a start with no override waits exactly that long", async () => {
    assert.ok(START_WAIT_MS < 30_000);
    recordAt(A);
    layDown(A);
    const waits = [];
    const timers = { setTimeout: (fn, ms) => waits.push(ms), clearTimeout: () => {} };
    const h = harness();
    await launch({ ...h.options, timers });
    assert.deepEqual(waits, [START_WAIT_MS], "neither startWaitMs nor the env seam: the constant");
    assert.equal(START_WAIT_ENV in h.options.env, false);

    const seam = harness();
    seam.options.env = { ...env, [START_WAIT_ENV]: "1234" };
    await launch({ ...seam.options, timers });
    assert.equal(waits[1], 1234, "the env seam overrides it");
    await launch({ ...seam.options, timers, startWaitMs: 77 });
    assert.equal(waits[2], 77, "the option beats the env seam");
  });

  test("DX-5075: a refresh whose install fails starts the recorded version, and its one line is printed at this start", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "fail" });
    const { version } = await launch(h.options);
    assert.equal(version, A, "the recorded version runs");
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /could not refresh .*install_failed: npm install @thehammer\/danx-dashboard-mcp@0\.1\.8 exited 1: npm error 404 Not Found\); this session keeps running 0\.1\.7\n$/);
    assert.equal(recordedVersionOrNull(env), A);
  });

  test("DX-5314: a refresh child that cannot start is ONE stderr line, never a failed launch", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    const inner = h.options.spawnFn;
    const withBrokenRefresh = (command, args, options) => {
      if (args[1] === REFRESH_FLAG) throw new Error("spawn EAGAIN");
      return inner(command, args, options);
    };
    const run = await launch({ ...h.options, spawnFn: withBrokenRefresh });
    assert.equal(run.version, A);
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /^\[danxbot dashboard MCP\] could not refresh .* \(could not start the refresh: spawn EAGAIN\); this session keeps running 0\.1\.7\n$/);

    const h2 = harness();
    const inner2 = h2.options.spawnFn;
    const asyncBroken = (command, args, options) => {
      const child = inner2(command, args, options);
      if (args[1] === REFRESH_FLAG) setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    };
    await launch({ ...h2.options, spawnFn: asyncBroken });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h2.errLines.length, 1);
    assert.match(h2.errLines[0], /could not start the refresh: spawn ENOENT/);
  });

  test("DX-5314: the failure lines an earlier refresh left in refresh.log are printed to this launcher's stderr at its start, once", async () => {
    recordAt(A);
    layDown(A);
    appendRefreshLog("[danxbot dashboard MCP] could not refresh the version (HTTP 500); this session keeps running 0.1.6\n", env);
    appendRefreshLog("[danxbot dashboard MCP] second\n", env);
    const h = harness();
    await launch(h.options);
    assert.deepEqual(h.errLines, ["[danxbot dashboard MCP] could not refresh the version (HTTP 500); this session keeps running 0.1.6\n[danxbot dashboard MCP] second\n"]);
    assert.equal(existsSync(refreshLogFile(env)), false, "the log is rotated away, so the lines are not printed twice");
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).filter((n) => n.startsWith("refresh.log")), []);
    const again = harness();
    await launch(again.options);
    assert.deepEqual(again.errLines, []);
  });

  test("DX-5314: a launcher that cannot start says only why: refresh.log is drained after the version is known to start, so the lines wait for the next start", async () => {
    appendRefreshLog("[danxbot dashboard MCP] an earlier refresh failed\n", env);
    registry.setMode("status-500");
    const h = harness();
    await assert.rejects(launch(h.options), /HTTP 500/);
    assert.deepEqual(h.errLines, [], "a launcher that failed to start prints no earlier refresh line");
    assert.equal(readFileSync(refreshLogFile(env), "utf8"), "[danxbot dashboard MCP] an earlier refresh failed\n", "the log is untouched, so the next start that works prints it");
  });

  test("DX-5314: a refresh.log.<pid>.read left by a launcher that died mid-read is printed and removed at the next drain; one a live launcher is reading is left alone", () => {
    const root = path.join(dataDir, "dashboard-mcp");
    mkdirSync(root, { recursive: true });
    const orphan = path.join(root, "refresh.log.4242.read");
    const live = path.join(root, "refresh.log.7777.read");
    writeFileSync(orphan, "orphaned line\n");
    writeFileSync(live, "being read by a live launcher\n");
    appendRefreshLog("fresh line\n", env);
    assert.equal(drainRefreshLog(env, (pid) => pid === 7777), "orphaned line\nfresh line\n");
    assert.equal(existsSync(orphan), false, "the crashed read's file is gone");
    assert.equal(readFileSync(live, "utf8"), "being read by a live launcher\n");
    assert.equal(drainRefreshLog(env, () => true), "", "nothing is printed twice");
    assert.equal(drainRefreshLog({ CLAUDE_PLUGIN_DATA: path.join(dataDir, "none") }), "", "no log directory at all is nothing to drain");
  });

  test("DX-5314: a .read file named by THIS process's pid (a dead launcher's, the pid reused) is read and removed, not overwritten by this drain's own rename", () => {
    const root = path.join(dataDir, "dashboard-mcp");
    mkdirSync(root, { recursive: true });
    const reused = path.join(root, `refresh.log.${process.pid}.read`);
    writeFileSync(reused, "dead launcher's line\n");
    appendRefreshLog("fresh line\n", env);
    assert.equal(drainRefreshLog(env, () => true), "dead launcher's line\nfresh line\n", "even a liveness check that says every pid is alive (ours is) reads it");
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith("refresh.log")), []);
  });

  test("DX-5314: an orphaned .read file with no fresh refresh.log is still returned and removed", () => {
    const root = path.join(dataDir, "dashboard-mcp");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "refresh.log.4242.read"), "orphaned line\n");
    assert.equal(existsSync(refreshLogFile(env)), false);
    assert.equal(drainRefreshLog(env, () => false), "orphaned line\n");
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith("refresh.log")), []);
  });

  test("DX-5314: an orphan that cannot be read for a reason other than it being gone (not ENOENT) throws, and is not removed", () => {
    const root = path.join(dataDir, "dashboard-mcp");
    mkdirSync(path.join(root, "refresh.log.4242.read"), { recursive: true }); // a directory: readFileSync fails EISDIR
    assert.throws(() => drainRefreshLog(env, () => false), (err) => err.code === "EISDIR");
    assert.equal(existsSync(path.join(root, "refresh.log.4242.read")), true);
  });

  test("the server gets the dashboard URL and never a dispatch's credential; a missing URL fails before anything runs", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    h.options.env = { ...env, CLAUDE_PROJECT_DIR: sessionFolder(), DANXBOT_PLUGIN_DASHBOARD_URL: "https://hosted", DANX_DASHBOARD_CREDENTIAL: "dispatch-secret" };
    await launch(h.options);
    const [{ options }] = h.servers;
    assert.equal(options.env.DANXBOT_DASHBOARD_URL, "https://hosted");
    assert.equal("DANX_DASHBOARD_CREDENTIAL" in options.env, false);
    assert.equal(options.stdio, "inherit", "the server owns the MCP stream");

    const none = harness();
    none.options.env = { ...env, CLAUDE_PROJECT_DIR: sessionFolder() };
    await assert.rejects(launch(none.options), /no dashboard URL/);
    assert.deepEqual(none.timeline, []);
  });
});

describe("runRefresh: the detached refresh (DX-4235, DX-5314)", () => {
  test("it records and installs a newer version without restarting the server; the next session starts it", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    const { child } = await launch(h.options);
    registry.setVersion(B);
    assert.equal(await runRefresh(A, h.options), B);
    assert.equal(recordedVersionOrNull(env), B);
    assert.ok(existsSync(installedBin(dataDir, B)));
    assert.deepEqual(h.timeline, [`refresh ${A}`, "registry request", `server ${A}`, "registry request", `npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${B}`]);
    assert.equal(h.servers.length, 1, "one server: the running one is never replaced");
    assert.equal(child.killed, false, "the running server is never restarted");
    assert.deepEqual(h.errLines, []);

    const next = harness();
    await launch(next.options);
    assert.deepEqual(next.timeline, [`refresh ${B}`, "registry request", `server ${B}`], "the next session start runs B, with no install");
  });

  test("a refresh that cannot read the registry writes ONE stderr line naming the reason and keeps the record", async () => {
    recordAt(A);
    layDown(A);
    registry.setMode("status-500");
    const h = harness();
    assert.equal(await runRefresh(A, h.options), null);
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /^\[danxbot dashboard MCP\] could not refresh the @thehammer\/danx-dashboard-mcp version \(.*HTTP 500\); this session keeps running 0\.1\.7\n$/);
    assert.equal(h.errLines[0].trimEnd().includes("\n"), false);
    assert.equal(recordedVersionOrNull(env), A);
  });

  test("a refresh whose install fails writes ONE stderr line with npm's reason and keeps the record", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "fail" });
    assert.equal(await runRefresh(A, h.options), null);
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /could not refresh .*install_failed: npm install @thehammer\/danx-dashboard-mcp@0\.1\.8 exited 1: npm error 404 Not Found\); this session keeps running 0\.1\.7\n$/);
    assert.equal(recordedVersionOrNull(env), A);
  });

  test("it leases the version the launcher ran while it works, and gives the lease back", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "hang" });
    const stop = new AbortController();
    const refreshing = runRefresh(A, { ...h.options, abort: stop.signal });
    while (h.npms.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")), [String(process.pid)]);
    stop.abort();
    await refreshing;
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")), []);
  });

  test("DX-5314: a refresh that is stopped mid-install kills npm, removes its stage, keeps the record, and writes ONE line (never nothing)", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "hang" });
    const stop = new AbortController();
    const refreshing = runRefresh(A, { ...h.options, abort: stop.signal });
    while (h.npms.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readdirSync(path.join(dataDir, "dashboard-mcp")).filter((n) => n.startsWith(".stage-")).length, 1, "its own stage exists while npm runs");
    stop.abort();
    assert.equal(await refreshing, null);
    assert.equal(h.npms[0].killed, true);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).filter((n) => n.startsWith(".stage-")), []);
    assert.equal(recordedVersionOrNull(env), A);
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /^\[danxbot dashboard MCP\] could not refresh the @thehammer\/danx-dashboard-mcp version \(aborted: installing @thehammer\/danx-dashboard-mcp@0\.1\.8 was stopped\); this session keeps running 0\.1\.7\n$/);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    test(`DX-5314: ${sig} stops the refresh process cleanly: npm is killed, the stage removed, ONE line goes to refresh.log, and it exits 1`, async () => {
      recordAt(A);
      layDown(A);
      registry.setVersion(B);
      const h = harness({ npmMode: "hang" });
      const proc = new EventEmitter();
      const exits = [];
      const running = runRefreshProcess(A, { ...h.options, proc, exit: (code) => exits.push(code) });
      while (h.npms.length === 0) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(exits, [], "still installing");
      proc.emit(sig);
      await running;
      assert.equal(h.npms[0].killed, true);
      assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).filter((n) => n.startsWith(".stage-")), []);
      assert.deepEqual(exits, [1]);
      assert.equal(recordedVersionOrNull(env), A);
      assert.deepEqual(h.errLines, [], "its stderr is never read: the line goes to refresh.log");
      assert.match(readFileSync(refreshLogFile(env), "utf8"), /^\[danxbot dashboard MCP\] could not refresh .*aborted: installing .* was stopped.*; this session keeps running 0\.1\.7\n$/);
    });
  }

  test("DX-5314: a refresh process that records the new version exits 0 and logs nothing", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness();
    const exits = [];
    await runRefreshProcess(A, { ...h.options, proc: new EventEmitter(), exit: (code) => exits.push(code) });
    assert.deepEqual(exits, [0]);
    assert.equal(recordedVersionOrNull(env), B);
    assert.equal(existsSync(refreshLogFile(env)), false);
  });

  test("after the refresh, an old install no live process runs is pruned; one another session still runs is kept", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    recordAt(A);
    layDown(A);
    for (const v of ["0.1.5", "0.1.6"]) {
      layDown(v);
      leaseVersion(v, { env, pid: v === "0.1.5" ? 555 : 666 });
      utimesSync(path.join(dataDir, "dashboard-mcp", v), old, old);
    }
    registry.setVersion(B);
    const h = harness();
    assert.equal(await runRefresh(A, { ...h.options, now: old.getTime() + 2 * STALE_INSTALL_MS, alive: (pid) => pid === 555 || pid === process.pid }), B);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).sort(), ["0.1.5", A, B, "current"]);
    assert.deepEqual(h.errLines, []);
  });

  test("a prune that fails is its own line, never a failed refresh: the new version stays recorded", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    recordAt(A);
    layDown(A);
    layDown("0.1.5");
    leaseVersion("0.1.5", { env, pid: 555 });
    utimesSync(path.join(dataDir, "dashboard-mcp", "0.1.5"), old, old);
    registry.setVersion(B);
    const h = harness();
    const latest = await runRefresh(A, {
      ...h.options,
      now: old.getTime() + 2 * STALE_INSTALL_MS,
      alive: () => {
        throw new Error("liveness check broke");
      },
    });
    assert.equal(latest, B);
    assert.equal(recordedVersionOrNull(env), B);
    assert.deepEqual(h.errLines, ["[danxbot dashboard MCP] could not prune old installs (liveness check broke); they stay until a later refresh prunes them\n"]);
  });

  test("the launcher's own lease on the version it runs lasts until it releases it", async () => {
    recordAt(A);
    layDown(A);
    const run = await launch(harness().options);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")), [String(process.pid)]);
    run.release();
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")), []);
  });

  test("no bash and no shell is ever spawned: npm, the server and the refresh child are started directly", async () => {
    const h = harness();
    await launch(h.options);
    recordAt(A);
    registry.setVersion(B);
    await runRefresh(A, h.options);
    assert.equal(h.spawns.length, 4, "npm A, refresh child, server, npm B");
    for (const { command, options } of h.spawns) {
      assert.doesNotMatch(command, /bash|\bsh\b|cmd\.exe/i);
      assert.equal(options.shell, undefined);
    }
    const servers = h.spawns.filter(({ args }) => !args.includes("install"));
    assert.ok(servers.every(({ command }) => command === process.execPath), "the server and the refresh run on this node");
  });
});

describe("the launcher process", () => {
  /** Runs the real launcher. The registry seam points at a closed port so a background refresh never reaches the network. */
  function run(extraEnv = {}) {
    return spawnSync(process.execPath, [LAUNCHER], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR, [REGISTRY_BASE_URL_ENV]: "http://127.0.0.1:9", [START_WAIT_ENV]: "1", ...extraEnv },
    });
  }

  test("runs the installed package with the hosted URL and without a dispatch's credential; its exit is the launcher's", () => {
    recordAt("0.1.50");
    const bin = installedBin(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write(JSON.stringify({ url: process.env.DANXBOT_DASHBOARD_URL, cred: process.env.DANX_DASHBOARD_CREDENTIAL ?? null, repo: process.env.DANX_REPO_NAME ?? null })); process.exit(4);`);
    const result = run({ CLAUDE_PROJECT_DIR: sessionFolder(), DANXBOT_PLUGIN_DASHBOARD_URL: "https://danxbot.sageus.ai", DANX_DASHBOARD_CREDENTIAL: "dispatch-secret" });
    assert.equal(result.status, 4, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { url: "https://danxbot.sageus.ai", cred: null, repo: null });
  });

  test("a folder whose .mcp.json declares danx-dashboard still gets the real server: the launcher has no standby mode", () => {
    recordAt("0.1.50");
    const bin = installedBin(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write("real-server"); process.exit(4);`);
    const project = sessionFolder({ env: { DANXBOT_DASHBOARD_URL: "https://danxbot.sageus.ai" } });
    writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "danx-dashboard": { command: "node", args: ["x.mjs"] } } }));
    const result = run({ CLAUDE_PROJECT_DIR: project });
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stdout, "real-server");
  });

  /** Runs the real launcher with an async spawn (a launcher that exits must not be waited out by the refresh child that holds its stderr). */
  function runAsync(extraEnv = {}) {
    const child = spawn(process.execPath, [LAUNCHER], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR, [REGISTRY_BASE_URL_ENV]: registry.url, [NPM_CLI_ENV]: FAKE_NPM, [START_WAIT_ENV]: "1", ...extraEnv },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const closed = new Promise((resolve) => child.once("close", resolve));
    return { child, exited, closed, stderr: () => stderr };
  }

  /** Waits for `condition`: the test asserts what is true once it holds, never how long it took. */
  async function until(condition, what) {
    for (let i = 0; i < 600; i += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`never happened: ${what}`);
  }

  const stages = () => readdirSync(path.join(dataDir, "dashboard-mcp")).filter((n) => n.startsWith(".stage-"));

  function layExiting(version, code) {
    const bin = installedBin(dataDir, version);
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.exit(${code});`);
  }

  test("DX-5314: a launcher that exits at once does not kill the refresh: the detached child finishes the install, records the new version, and leaves no stage or lease", async () => {
    recordAt(A);
    layExiting(A, 4);
    registry.setVersion(B);
    const gate = path.join(dataDir, "npm-may-finish");
    const launcher = runAsync({ FAKE_NPM_GATE: gate });
    assert.equal(await launcher.exited, 4, "the launcher exits with the server's code, not waiting for the refresh");
    // the refresh child holds none of the launcher's stdio: the launcher's pipes close at its exit while the child is still installing (a hang guard, not a timing claim)
    await Promise.race([launcher.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("the launcher's stderr is held open by the refresh child")), 20_000))]);
    // the refresh child is in its install (its own stage exists) after the launcher is gone, and the record has not moved
    await until(() => stages().length === 1, "the refresh child's npm made its stage");
    assert.equal(recordedVersionOrNull(env), A);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")).length, 1, "the refresh child holds a lease on the version the launcher ran");
    writeFileSync(gate, "");
    await until(() => recordedVersionOrNull(env) === B, "the refresh recorded the new version");
    assert.ok(existsSync(installedBin(dataDir, B)));
    await launcher.closed;
    assert.equal(launcher.stderr(), "", "a refresh that finishes writes no line");
    await until(() => stages().length === 0 && readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")).length === 0, "the stage and the lease are gone");
  });

  test("DX-5075: a session started after a publish runs it: the real detached refresh child records the new version before the wait ends, and the launcher runs that version", async () => {
    recordAt(A);
    layExiting(A, 4);
    registry.setVersion(B);
    // a generous wait: the launcher stops waiting the moment the refresh child exits 0, so this bounds only a hang
    const launcher = runAsync({ [START_WAIT_ENV]: "120000" });
    let stdout = "";
    launcher.child.stdout.on("data", (chunk) => (stdout += chunk));
    assert.equal(await launcher.exited, 3, `the stub server of ${B} exited with its own code: ${launcher.stderr()}`);
    await launcher.closed;
    assert.equal(stdout, `ran ${B}`, "the server that ran is the newly published version, not the recorded one");
    assert.equal(recordedVersionOrNull(env), B);
    assert.equal(launcher.stderr(), "");
  });

  test("DX-5314: a refresh that fails after the launcher exited writes ONE line to refresh.log, and the NEXT launcher prints it to its stderr", async () => {
    recordAt(A);
    layExiting(A, 4);
    registry.setMode("status-500");
    const first = runAsync();
    assert.equal(await first.exited, 4);
    await first.closed;
    assert.equal(first.stderr(), "", "the first launcher is gone: the line is not in its stderr");
    await until(() => existsSync(refreshLogFile(env)), "the refresh child logged its failure");
    assert.equal(recordedVersionOrNull(env), A);
    const second = runAsync();
    assert.equal(await second.exited, 4);
    await second.closed;
    assert.match(second.stderr(), /^\[danxbot dashboard MCP\] could not refresh the @thehammer\/danx-dashboard-mcp version \(.*HTTP 500\); this session keeps running 0\.1\.7\n$/);
    // the second launcher's own refresh fails the same way and logs it; wait for that so no child writes after the test's directory is removed
    await until(() => existsSync(refreshLogFile(env)), "the second refresh child logged its failure");
  });

  test("DX-5314: the refresh process refuses to run without the version it was started for, in ONE logged line", () => {
    const result = spawnSync(process.execPath, [LAUNCHER, REFRESH_FLAG], { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "", "the refresh stderr is never read by anyone: its line goes to refresh.log");
    assert.equal(readFileSync(refreshLogFile(env), "utf8"), "[danxbot dashboard MCP] the refresh was started without the running version (null)\n");
  });

  test("a failure to start exits 1 with ONE stderr line naming the reason and writes nothing to stdout", () => {
    const result = run({ CLAUDE_PLUGIN_DATA: "", DANXBOT_DASHBOARD_URL: "https://danxbot.sageus.ai" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "[danxbot dashboard MCP] CLAUDE_PLUGIN_DATA is not set: this only runs as part of the danxbot plugin\n");
    assert.equal(result.stdout, "");
  });

  test("its source starts no bash and no shell (DX-4235)", () => {
    for (const file of [LAUNCHER, path.join(PLUGIN_ROOT, "scripts", "lib", "dashboard-mcp-package.mjs")]) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /bash\.exe|GIT_BASH|spawn(Sync)?\(\s*["'`](ba)?sh["'`]/, file);
      assert.doesNotMatch(source, /\bshell:\s*true\s*[,}]/, file); // the option, never the docblock explaining why there is none
    }
  });
});
