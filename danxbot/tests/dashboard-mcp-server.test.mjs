// dashboard-mcp-server.mjs (DX-4555, DX-4578, DX-4235): the MCP server the plugin ships, the one dashboard server of every
// session. It starts the server from the recorded version at once and refreshes the record in the background. A fake
// registry (fixtures/fake-registry.mjs) stands in for npm's registry and an injected spawn for npm and the server; the
// end-to-end cases run the real launcher process against a pre-installed fake package. Nothing here touches the network.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_MCP_PACKAGE_NAME, STALE_INSTALL_MS, installedBin, leaseVersion, recordedVersionOrNull, writeRecordedVersion } from "../scripts/lib/dashboard-mcp-package.mjs";
import { dashboardUrl, launch } from "../scripts/dashboard-mcp-server.mjs";
import { REGISTRY_BASE_URL_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const LAUNCHER = path.join(PLUGIN_ROOT, "scripts", "dashboard-mcp-server.mjs");
const A = "0.1.7";
const B = "0.1.8";
const NPM = { command: "npm", args: [] };

let dataDir;
let registry;
let env;
beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dash-mcp-data-"));
  registry = await startFakeRegistry({ version: A });
  env = { CLAUDE_PLUGIN_DATA: dataDir, DANXBOT_DASHBOARD_URL: "https://dash.example", [REGISTRY_BASE_URL_ENV]: registry.url };
});
afterEach(async () => {
  await registry.stop();
  rmSync(dataDir, { recursive: true, force: true });
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
  const errLines = [];
  const spawnFn = (command, args, options) => {
    spawns.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => (child.killed = true);
    if (args.includes("install")) {
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
  return { timeline, spawns, servers, npms, errLines, options: { env, spawnFn, fetchFn, stderr, npm: NPM } };
}

describe("dashboardUrl", () => {
  test("an explicit DANXBOT_DASHBOARD_URL beats the plugin's configured value, which beats nothing", () => {
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "https://a", DANXBOT_PLUGIN_DASHBOARD_URL: "https://b" }), "https://a");
    assert.equal(dashboardUrl({ DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://b" }), "https://b");
    assert.throws(() => dashboardUrl({}), /no dashboard URL/);
  });
});

describe("launch: the version the server starts from (DX-4235)", () => {
  test("a recorded version starts the server at once, before any registry request", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    const { child, version, refresh } = await launch(h.options);
    assert.equal(version, A);
    assert.equal(h.timeline[0], `server ${A}`, `the server came first: ${h.timeline}`);
    assert.equal(await refresh, A);
    assert.deepEqual(h.timeline, [`server ${A}`, "registry request"]);
    assert.equal(child.killed, false);
  });

  test("a recorded version that is not installed is installed first, still before any registry request", async () => {
    recordAt(A);
    const h = harness();
    await (await launch(h.options)).refresh;
    assert.deepEqual(h.timeline, [`npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${A}`, `server ${A}`, "registry request"]);
  });

  test("with no record it resolves from the registry first, installs and records that version, then starts the server", async () => {
    const h = harness();
    const { version, refresh } = await launch(h.options);
    assert.equal(version, A);
    assert.equal(recordedVersionOrNull(env), A);
    await refresh;
    assert.deepEqual(h.timeline, ["registry request", `npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${A}`, `server ${A}`, "registry request"]);
  });

  test("the background refresh records and installs a newer version without restarting the server; the next session starts it", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness();
    const { child, refresh } = await launch(h.options);
    assert.equal(await refresh, B);
    assert.equal(recordedVersionOrNull(env), B);
    assert.ok(existsSync(installedBin(dataDir, B)));
    assert.deepEqual(h.timeline, [`server ${A}`, "registry request", `npm install ${DASHBOARD_MCP_PACKAGE_NAME}@${B}`]);
    assert.equal(h.servers.length, 1, "one server: the running one is never replaced");
    assert.equal(child.killed, false, "the running server is never restarted");
    assert.deepEqual(h.errLines, []);

    const next = harness();
    await (await launch(next.options)).refresh;
    assert.deepEqual(next.timeline, [`server ${B}`, "registry request"], "the next session start runs B at once, with no install");
  });

  test("a refresh that cannot read the registry writes ONE stderr line naming the reason and keeps the record", async () => {
    recordAt(A);
    layDown(A);
    registry.setMode("status-500");
    const h = harness();
    const { child, refresh } = await launch(h.options);
    assert.equal(await refresh, null);
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /^\[danxbot dashboard MCP\] could not refresh the @thehammer\/danx-dashboard-mcp version \(.*HTTP 500\); this session keeps running 0\.1\.7\n$/);
    assert.equal(h.errLines[0].trimEnd().includes("\n"), false);
    assert.equal(recordedVersionOrNull(env), A);
    assert.equal(child.killed, false);
  });

  test("a refresh whose install fails writes ONE stderr line with npm's reason and keeps the record", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "fail" });
    const { refresh } = await launch(h.options);
    assert.equal(await refresh, null);
    assert.equal(h.errLines.length, 1);
    assert.match(h.errLines[0], /could not refresh .*install_failed: npm install @thehammer\/danx-dashboard-mcp@0\.1\.8 exited 1: npm error 404 Not Found\); this session keeps running 0\.1\.7\n$/);
    assert.equal(recordedVersionOrNull(env), A);
  });

  test("no bash and no shell is ever spawned: npm and the server are the only processes, started directly", async () => {
    const h = harness();
    registry.setVersion(A);
    await (await launch(h.options)).refresh;
    recordAt(A);
    registry.setVersion(B);
    await (await launch(h.options)).refresh;
    assert.equal(h.spawns.length, 4, "npm A, server, server, npm B");
    for (const { command, options } of h.spawns) {
      assert.doesNotMatch(command, /bash|\bsh\b|cmd\.exe/i);
      assert.equal(options.shell, undefined);
    }
    const servers = h.spawns.filter(({ args }) => !args.includes("install"));
    assert.ok(servers.every(({ command }) => command === process.execPath), "the server runs on this node");
  });

  test("the server gets the dashboard URL and never a dispatch's credential; a missing URL fails before anything runs", async () => {
    recordAt(A);
    layDown(A);
    const h = harness();
    h.options.env = { ...env, DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://hosted", DANX_DASHBOARD_CREDENTIAL: "dispatch-secret" };
    await (await launch(h.options)).refresh;
    const [{ options }] = h.servers;
    assert.equal(options.env.DANXBOT_DASHBOARD_URL, "https://hosted");
    assert.equal("DANX_DASHBOARD_CREDENTIAL" in options.env, false);
    assert.equal(options.stdio, "inherit", "the server owns the MCP stream");

    const none = harness();
    none.options.env = { ...env, DANXBOT_DASHBOARD_URL: "" };
    await assert.rejects(launch(none.options), /no dashboard URL/);
    assert.deepEqual(none.timeline, []);
  });
});

describe("launch: what a session holds and leaves behind (DX-4235)", () => {
  const leases = (version) => readdirSync(path.join(dataDir, "dashboard-mcp", version, ".leases"));

  test("the version it runs is leased by this process until it releases it", async () => {
    recordAt(A);
    layDown(A);
    const run = await launch(harness().options);
    await run.refresh;
    assert.deepEqual(leases(A), [String(process.pid)]);
    run.release();
    assert.deepEqual(leases(A), []);
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
    const run = await launch({ ...h.options, now: old.getTime() + 2 * STALE_INSTALL_MS, alive: (pid) => pid === 555 || pid === process.pid });
    assert.equal(await run.refresh, B);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).sort(), ["0.1.5", A, B, "current"]);
    assert.deepEqual(h.errLines, []);
    run.release();
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
    const run = await launch({
      ...h.options,
      now: old.getTime() + 2 * STALE_INSTALL_MS,
      alive: () => {
        throw new Error("liveness check broke");
      },
    });
    assert.equal(await run.refresh, B);
    assert.equal(recordedVersionOrNull(env), B);
    assert.deepEqual(h.errLines, ["[danxbot dashboard MCP] could not prune old installs (liveness check broke); they stay until a later refresh prunes them\n"]);
    run.release();
  });

  test("a server that exits mid-refresh stops it: npm is killed, its stage removed, the record kept, and no failure line", async () => {
    recordAt(A);
    layDown(A);
    registry.setVersion(B);
    const h = harness({ npmMode: "hang" });
    const run = await launch(h.options);
    while (h.npms.length === 0) await new Promise((resolve) => setImmediate(resolve));
    run.stopRefresh();
    assert.equal(await run.refresh, null);
    assert.equal(h.npms[0].killed, true);
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).filter((n) => n.startsWith(".stage-")), []);
    assert.equal(recordedVersionOrNull(env), A);
    assert.deepEqual(h.errLines, []);
    run.release();
  });
});

describe("the launcher process", () => {
  /** Runs the real launcher. The registry seam points at a closed port so a background refresh never reaches the network. */
  function run(extraEnv = {}) {
    return spawnSync(process.execPath, [LAUNCHER], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, [REGISTRY_BASE_URL_ENV]: "http://127.0.0.1:9", ...extraEnv },
    });
  }

  test("runs the installed package with the hosted URL and without a dispatch's credential; its exit is the launcher's", () => {
    recordAt("0.1.50");
    const bin = installedBin(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write(JSON.stringify({ url: process.env.DANXBOT_DASHBOARD_URL, cred: process.env.DANX_DASHBOARD_CREDENTIAL ?? null, repo: process.env.DANX_REPO_NAME ?? null })); process.exit(4);`);
    const result = run({ DANXBOT_DASHBOARD_URL: "", DANXBOT_PLUGIN_DASHBOARD_URL: "https://danxbot.sageus.ai", DANX_DASHBOARD_CREDENTIAL: "dispatch-secret" });
    assert.equal(result.status, 4, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { url: "https://danxbot.sageus.ai", cred: null, repo: null });
  });

  test("a folder whose .mcp.json declares danx-dashboard still gets the real server: the launcher has no standby mode", () => {
    recordAt("0.1.50");
    const bin = installedBin(dataDir, "0.1.50");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `process.stdout.write("real-server"); process.exit(4);`);
    const project = mkdtempSync(path.join(tmpdir(), "dash-mcp-project-"));
    try {
      writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "danx-dashboard": { command: "node", args: ["x.mjs"] } } }));
      const result = run({ CLAUDE_PROJECT_DIR: project, DANXBOT_DASHBOARD_URL: "https://danxbot.sageus.ai" });
      assert.equal(result.status, 4, result.stderr);
      assert.equal(result.stdout, "real-server");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("DX-4235: a server that exits while a refresh installs: npm is stopped and its stage removed, the lease released, the record kept, and the launcher exits with the server's code", () => {
    recordAt(A);
    const bin = installedBin(dataDir, A);
    mkdirSync(path.dirname(bin), { recursive: true });
    // the stand-in server exits once the refresh's npm has made its stage (npm against the registry below never finishes on its own)
    writeFileSync(
      bin,
      `import fs from "node:fs"; import path from "node:path";
const root = path.join(process.env.CLAUDE_PLUGIN_DATA, "dashboard-mcp");
const tick = setInterval(() => { if (fs.readdirSync(root).some((n) => n.startsWith(".stage-"))) { clearInterval(tick); process.exit(4); } }, 50);`,
    );
    writeFileSync(path.join(path.dirname(bin), "..", "package.json"), JSON.stringify({ type: "module" }));
    registry.setVersion(B);
    registry.setMode("latest-only");
    const result = spawnSync(process.execPath, [LAUNCHER], {
      input: "",
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, DANXBOT_DASHBOARD_URL: "https://dash.example", [REGISTRY_BASE_URL_ENV]: registry.url, npm_config_registry: registry.url },
    });
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.stderr, "", "a stopped refresh writes no failure line");
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp")).sort(), [A, "current"], "no stage left, and no install of B");
    assert.deepEqual(readdirSync(path.join(dataDir, "dashboard-mcp", A, ".leases")), [], "the lease is released");
    assert.equal(recordedVersionOrNull(env), A);
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
