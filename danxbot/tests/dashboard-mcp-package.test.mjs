// DX-4321 / DX-3811 / DX-4235 — scripts/lib/dashboard-mcp-package.mjs: the ONE module that says which version of
// `@thehammer/danx-dashboard-mcp` runs and installs it. The plugin carries no version literal: the registry's `latest` is
// recorded under the plugin data dir and read back with no network. A fake registry (fixtures/fake-registry.mjs) stands
// in for npm's registry and an injected spawn for npm itself; nothing here touches the network except the one describe
// at the end that checks the REAL published package, deliberately.
import { test, describe, before, beforeEach, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_MCP_PACKAGE_NAME,
  INSTALL_TIMEOUT_MS,
  RENAME_RETRY_ATTEMPTS,
  RENAME_RETRY_BASE_MS,
  RENAME_RETRYABLE_CODES,
  STALE_INSTALL_MS,
  installVersion,
  installedBin,
  leaseVersion,
  npmCommand,
  pruneInstalls,
  recordedVersionOrNull,
  refreshInstall,
  registryUrl,
  renameRetrying,
  requireRecordedVersion,
  resolveLatestVersion,
  startVersion,
  writeRecordedVersion,
} from "../scripts/lib/dashboard-mcp-package.mjs";
import { LIVE_SUBCOMMAND } from "../scripts/subagents-live.mjs";
import { listPluginFiles } from "../../scripts/check-general-audience.mjs";
import { REGISTRY_BASE_URL_ENV, REGISTRY_TIMEOUT_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LATEST_PATH = "/@thehammer%2Fdanx-dashboard-mcp/latest";
const SPEC = (version) => `${DASHBOARD_MCP_PACKAGE_NAME}@${version}`;

let dataDir;
let registry;
let env;
beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mcp-package-data-"));
  registry = await startFakeRegistry({ version: "0.1.50" });
  env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, [REGISTRY_BASE_URL_ENV]: registry.url };
});
afterEach(async () => {
  await registry.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const installRoot = () => path.join(dataDir, "dashboard-mcp");
const recordFile = () => path.join(installRoot(), "current");

function recordAt(version) {
  mkdirSync(path.dirname(recordFile()), { recursive: true });
  writeFileSync(recordFile(), `${version}\n`);
}

/** Puts `content` where `version`'s install lives, as a finished install would. */
function layDown(version, content = `installed ${version}`) {
  const bin = installedBin(dataDir, version);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, content);
  return bin;
}

/**
 * A stand-in for npm's process (`installVersion`'s `spawnFn` seam). `mode` decides what `npm install --prefix <stage> ...`
 * does:
 *   ok      lays the package's entry point down under <stage>, exits 0
 *   race    another session's install of the same version lands at the final path first, then ours under <stage>, exits 0
 *   no-bin  exits 0 leaving nothing
 *   fail    prints npm's error lines, exits 1
 *   hang    never exits until killed
 *   error   the process cannot be started at all
 * `calls` records every spawn; `onSpawn(args)` runs at spawn time (to observe the filesystem then).
 */
function fakeNpm(mode = "ok", onSpawn = () => {}) {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    onSpawn(args);
    const child = new EventEmitter();
    children.push(child);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, "SIGTERM"));
    };
    const stage = args[args.indexOf("--prefix") + 1];
    const version = args.at(-1).split("@").at(-1);
    const lay = (prefix, content) => {
      const bin = path.join(prefix, "node_modules", ...DASHBOARD_MCP_PACKAGE_NAME.split("/"), "dist", "index.js");
      mkdirSync(path.dirname(bin), { recursive: true });
      writeFileSync(bin, content);
    };
    setImmediate(() => {
      switch (mode) {
        case "ok":
          lay(stage, "ours");
          return child.emit("close", 0, null);
        case "race":
          layDown(version, "the winner's");
          lay(stage, "the loser's");
          return child.emit("close", 0, null);
        case "no-bin":
          return child.emit("close", 0, null);
        case "fail":
          child.stderr.emit("data", "npm error code E404\nnpm error 404 Not Found - registry unreachable\n\n");
          return child.emit("close", 1, null);
        case "hang":
          return undefined;
        case "error":
          return child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
      }
    });
    return child;
  };
  return { spawnFn, calls, children };
}

const NPM = { command: "npm", args: [] };
const oneLineOnly = (err) => assert.equal(err.message.includes("\n"), false, `ONE line: ${err.message}`);

describe("resolveLatestVersion", () => {
  test("asks GET <registry>/<name>/latest and returns the strict x.y.z it answers", async () => {
    assert.equal(await resolveLatestVersion({ env }), "0.1.50");
    assert.deepEqual(registry.requests(), [LATEST_PATH]);
    registry.setVersion("12.345.6789");
    assert.equal(await resolveLatestVersion({ env }), "12.345.6789");
  });

  test("the registry base URL has a public default and an env override (the test seam)", () => {
    assert.equal(registryUrl({}), `https://registry.npmjs.org${LATEST_PATH}`);
    assert.equal(registryUrl({ [REGISTRY_BASE_URL_ENV]: "http://127.0.0.1:9/" }), `http://127.0.0.1:9${LATEST_PATH}`);
    assert.equal(DASHBOARD_MCP_PACKAGE_NAME, "@thehammer/danx-dashboard-mcp");
  });

  test("a non-200 throws naming the URL and the status", async () => {
    registry.setMode("status-500");
    await assert.rejects(resolveLatestVersion({ env }), (err) => {
      assert.ok(err.message.includes(`${registry.url}${LATEST_PATH}`), err.message);
      assert.match(err.message, /HTTP 500/);
      return true;
    });
  });

  for (const [label, body] of [
    ["0.1", '{"version":"0.1"}'],
    ["v1.2.3", '{"version":"v1.2.3"}'],
    ["1.2.3-beta", '{"version":"1.2.3-beta"}'],
    ["1.2.3.4", '{"version":"1.2.3.4"}'],
    ["a version that is not a string", '{"version":123}'],
    ["no version field", "{}"],
    ["an empty body", ""],
    ["a body that is not JSON", "<html>bad gateway</html>"],
  ]) {
    test(`a malformed answer (${label}) throws naming the URL and the reason`, async () => {
      registry.setMode("body", body);
      await assert.rejects(resolveLatestVersion({ env }), (err) => {
        assert.ok(err.message.includes(`${registry.url}${LATEST_PATH}`), err.message);
        assert.match(err.message, /not (valid JSON|a strict x\.y\.z version)/);
        return true;
      });
    });
  }

  test("an unreachable registry throws naming the URL and the network error", async () => {
    const dead = registry.url;
    await registry.stop();
    registry = await startFakeRegistry(); // so afterEach has something to stop
    await assert.rejects(resolveLatestVersion({ env: { ...env, [REGISTRY_BASE_URL_ENV]: dead } }), (err) => {
      assert.ok(err.message.includes(`${dead}${LATEST_PATH}`), err.message);
      assert.match(err.message, /network error/);
      return true;
    });
  });

  test("a registry that never answers is cut off at the bound, naming it", async () => {
    registry.setMode("hang");
    await assert.rejects(resolveLatestVersion({ env, timeoutMs: 300 }), (err) => {
      assert.ok(err.message.includes(LATEST_PATH), err.message);
      assert.match(err.message, /no answer within 300ms/);
      return true;
    });
  });

  test("the env timeout seam bounds the request when no timeout is passed", async () => {
    registry.setMode("hang");
    await assert.rejects(resolveLatestVersion({ env: { ...env, [REGISTRY_TIMEOUT_ENV]: "250" } }), /no answer within 250ms/);
  });
});

describe("recorded version", () => {
  test("the reader returns the recorded version, and null when nothing is recorded; it makes no registry request", () => {
    assert.equal(recordedVersionOrNull(env), null);
    recordAt("0.1.7");
    assert.equal(recordedVersionOrNull(env), "0.1.7");
    assert.deepEqual(registry.requests(), []);
  });

  test("the record file is where every reader looks: dashboard-mcp/current under the plugin data dir", () => {
    writeRecordedVersion("0.1.7", env);
    assert.equal(readFileSync(path.join(dataDir, "dashboard-mcp", "current"), "utf8"), "0.1.7\n");
  });

  test("a record that exists but is damaged or unreadable is a loud failure naming the file and the fix, never read as no record", async () => {
    for (const text of ["not-a-version", "", "0.1", "v1.2.3", "1.2.3-beta"]) {
      recordAt(text);
      assert.throws(
        () => recordedVersionOrNull(env),
        (err) => err.message.includes(recordFile()) && /damaged/.test(err.message) && err.message.includes(`delete ${recordFile()}`),
        JSON.stringify(text),
      );
    }
    rmSync(recordFile());
    mkdirSync(recordFile()); // a directory where the record should be: unreadable, not absent
    assert.throws(() => recordedVersionOrNull(env), (err) => err.message.includes(recordFile()) && /cannot be read/.test(err.message));
    const npm = fakeNpm();
    await assert.rejects(startVersion({ env, spawnFn: npm.spawnFn, npm: NPM }), /cannot be read/);
    assert.deepEqual(registry.requests(), [], "a damaged record is reported, not papered over with a network request");
    assert.deepEqual(npm.calls, []);
  });

  test("requireRecordedVersion (subagents-live.mjs's read) answers the record, and with none a line saying nothing can run", () => {
    assert.throws(() => requireRecordedVersion(env), /no .*version is recorded.*nothing that runs it can start/);
    recordAt("0.1.7");
    assert.equal(requireRecordedVersion(env), "0.1.7");
  });

  test("a write targets a temp name and renames it onto the record: the record itself is never written in place", () => {
    const calls = [];
    const spy = {
      mkdirSync: (...args) => (calls.push(["mkdir", args[0]]), fs.mkdirSync(...args)),
      writeFileSync: (...args) => (calls.push(["write", args[0]]), fs.writeFileSync(...args)),
      renameSync: (...args) => (calls.push(["rename", args[0], args[1]]), fs.renameSync(...args)),
      rmSync: (...args) => fs.rmSync(...args),
    };
    writeRecordedVersion("0.1.9", env, spy);
    const write = calls.find(([kind]) => kind === "write");
    const rename = calls.find(([kind]) => kind === "rename");
    assert.notEqual(write[1], recordFile(), "the version is never written straight into the record");
    assert.match(write[1], /current\..*\.tmp$/);
    assert.deepEqual(rename.slice(1), [write[1], recordFile()], "the temp file is renamed onto the record");
    assert.ok(calls.indexOf(write) < calls.indexOf(rename));
    assert.equal(recordedVersionOrNull(env), "0.1.9");
    assert.deepEqual(readdirSync(installRoot()), ["current"], "no temp file left behind");
  });

  test("a record that cannot be WRITTEN is reported as that, with its own reason and fix", () => {
    writeFileSync(installRoot(), "a file where the record's directory belongs");
    assert.throws(() => writeRecordedVersion("0.1.50", env), (err) => {
      assert.match(err.message, /could not record version 0\.1\.50/);
      assert.ok(err.message.includes(`make ${installRoot()} writable`), err.message);
      return true;
    });
  });

  test("a real observer: another process polling the record while this one replaces it hundreds of times never reads a partial one", async () => {
    recordAt("0.1.50");
    const readyFile = path.join(dataDir, "observer-ready");
    const stopFile = path.join(dataDir, "observer-stop");
    const observer = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
         const [file, readyFile, stopFile] = process.argv.slice(1);
         const safety = Date.now() + 20000;
         let reads = 0;
         const bad = [];
         fs.writeFileSync(readyFile, "");
         const nap = new Int32Array(new SharedArrayBuffer(4));
         while (!fs.existsSync(stopFile) && Date.now() < safety) {
           if (reads % 16 === 0) Atomics.wait(nap, 0, 0, 1); // yield now and then (and after every failed read): a pure busy spin starves the writer's rename of an open file on Windows
           let text;
           try { text = fs.readFileSync(file, "utf8"); } catch { continue; } // a rename in flight can refuse a read on Windows; a partial write cannot hide behind it
           reads += 1;
           if (!/^0\\.1\\.5[01]\\n$/.test(text)) bad.push(JSON.stringify(text));
         }
         process.stdout.write(JSON.stringify({ reads, bad: bad.slice(0, 5) }));`,
        recordFile(),
        readyFile,
        stopFile,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    observer.stdout.on("data", (chunk) => (out += chunk));
    const closed = new Promise((resolve) => observer.on("close", resolve));
    while (!existsSync(readyFile)) await new Promise((resolve) => setTimeout(resolve, 10));
    // Write until enough replacements happened (not for a fixed time: a loaded machine does fewer per second), with a cap.
    const until = Date.now() + 15_000;
    let writes = 0;
    for (let i = 0; writes <= 150 && Date.now() < until; i += 1) {
      try {
        writeRecordedVersion(i % 2 === 0 ? "0.1.51" : "0.1.50", env);
        writes += 1;
      } catch (err) {
        // Windows can refuse a rename over a file the observer has open past the retry budget under load: not a partial write.
        if (!/could not record version .*\((EPERM|EBUSY|EACCES)\)/.test(err.message)) throw err;
      }
    }
    writeFileSync(stopFile, "");
    await closed;
    const result = JSON.parse(out);
    assert.ok(writes > 100, `the writer actually replaced the record: ${writes}`);
    assert.ok(result.reads > 100, `the observer actually read: ${result.reads}`);
    assert.deepEqual(result.bad, [], "a partial or empty record was observable");
  });
});

describe("npmCommand: npm with no shell (DX-4235)", () => {
  test("on Windows the running node runs npm's own npm-cli.js from beside it: no .cmd, no shell", () => {
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const seen = [];
    assert.deepEqual(npmCommand("win32", node, (f) => (seen.push(f), true)), { command: node, args: [cli] });
    assert.deepEqual(seen, [cli]);
  });

  test("on Windows a node with no npm beside it is a loud failure naming both paths", () => {
    assert.throws(() => npmCommand("win32", "D:\\n\\node.exe", () => false), /^Error: npm_not_found: the node running this \(D:\\n\\node\.exe\) has no npm beside it at D:\\n\\node_modules\\npm\\bin\\npm-cli\.js$/);
  });

  test("elsewhere `npm` from PATH, which the OS starts directly", () => {
    assert.deepEqual(npmCommand("linux", "/usr/bin/node", () => assert.fail("no lookup")), { command: "npm", args: [] });
    assert.deepEqual(npmCommand("darwin", "/opt/homebrew/bin/node", () => assert.fail("no lookup")), { command: "npm", args: [] });
  });

  test("this machine's own answer exists (the command a real install runs)", () => {
    const npm = npmCommand();
    for (const file of npm.args) assert.ok(existsSync(file), file);
  });
});

describe("installVersion", () => {
  test("installs the version into a staging directory, then renames it into dashboard-mcp/<version>, and returns its entry point", async () => {
    const npm = fakeNpm();
    const bin = await installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: { command: "/x/node", args: ["/x/npm-cli.js"] } });
    assert.equal(bin, path.join(dataDir, "dashboard-mcp", "0.1.50", "node_modules", "@thehammer", "danx-dashboard-mcp", "dist", "index.js"));
    assert.equal(readFileSync(bin, "utf8"), "ours");
    assert.equal(npm.calls.length, 1);
    const [{ command, args, options }] = npm.calls;
    assert.equal(command, "/x/node");
    const stage = args[args.indexOf("--prefix") + 1];
    assert.deepEqual(args, ["/x/npm-cli.js", "install", "--prefix", stage, "--no-audit", "--no-fund", "--no-save", "--loglevel=error", SPEC("0.1.50")]);
    assert.equal(path.dirname(stage), installRoot(), "the stage is beside the version directories (same filesystem: the rename is atomic)");
    assert.match(path.basename(stage), /^\.stage-/);
    assert.equal(existsSync(stage), false, "the stage was renamed into place");
    assert.deepEqual(readdirSync(installRoot()), ["0.1.50"]);
    assert.equal(options.shell, undefined, "no shell");
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"], "npm's output never reaches the launcher's stdout (the MCP stream)");
  });

  test("an installed version is returned as is: npm never runs", async () => {
    const existing = layDown("0.1.50");
    const npm = fakeNpm();
    assert.equal(await installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM }), existing);
    assert.deepEqual(npm.calls, []);
  });

  test("the loser of a concurrent install keeps the winner's: nothing is nested inside it and the loser's stage is gone", async () => {
    const npm = fakeNpm("race");
    const bin = await installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM });
    assert.equal(readFileSync(bin, "utf8"), "the winner's");
    assert.deepEqual(readdirSync(path.join(installRoot(), "0.1.50")), ["node_modules"], "the loser's stage was not moved inside the winner's install");
    assert.deepEqual(readdirSync(installRoot()), ["0.1.50"], "the loser's stage is discarded");
  });

  test("an install that outlives its bound fails loudly with one line, npm is killed, and nothing is left behind", async () => {
    assert.equal(INSTALL_TIMEOUT_MS, 60_000);
    const npm = fakeNpm("hang");
    await assert.rejects(installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM, installTimeoutMs: 1 }), (err) => {
      assert.match(err.message, /^timeout: installing @thehammer\/danx-dashboard-mcp@0\.1\.50 took longer than /);
      oneLineOnly(err);
      return true;
    });
    assert.equal(npm.calls.length, 1);
    assert.equal(npm.children[0].killed, true, "npm is killed");
    assert.deepEqual(readdirSync(installRoot()), [], "no stage and no version directory");
  });

  test("DX-4235: an abort (the server exited mid-refresh) kills npm, waits for it to close, removes the stage and names why", async () => {
    const npm = fakeNpm("hang");
    const stop = new AbortController();
    const installing = installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM, abort: stop.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readdirSync(installRoot()).filter((n) => n.startsWith(".stage-")).length, 1, "the stage exists while npm runs");
    stop.abort();
    await assert.rejects(installing, /^Error: aborted: installing @thehammer\/danx-dashboard-mcp@0\.1\.50 was stopped because the server exited$/);
    assert.equal(npm.children[0].killed, true);
    assert.deepEqual(readdirSync(installRoot()), [], "no stage and no version directory");
  });

  test("an npm failure fails loudly with one line carrying npm's own last line, and nothing is left behind", async () => {
    const npm = fakeNpm("fail");
    await assert.rejects(installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM }), (err) => {
      assert.equal(err.message, "install_failed: npm install @thehammer/danx-dashboard-mcp@0.1.50 exited 1: npm error 404 Not Found - registry unreachable");
      return true;
    });
    assert.deepEqual(readdirSync(installRoot()), []);
  });

  test("an install that succeeds but leaves no entry point is a failure, not a path to nothing", async () => {
    const npm = fakeNpm("no-bin");
    await assert.rejects(installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM }), (err) => {
      assert.match(err.message, /^install_incomplete: .*left no node_modules\/@thehammer\/danx-dashboard-mcp\/dist\/index\.js$/);
      return true;
    });
    assert.deepEqual(readdirSync(installRoot()), []);
  });

  test("npm that cannot be started at all fails loudly with one line naming the command", async () => {
    const npm = fakeNpm("error");
    await assert.rejects(installVersion("0.1.50", { env, spawnFn: npm.spawnFn, npm: NPM }), (err) => {
      assert.match(err.message, /^npm_not_started: could not start npm \(npm\) for installing .*0\.1\.50: spawn npm ENOENT$/);
      return true;
    });
    assert.deepEqual(readdirSync(installRoot()), []);
  });

  test("a missing CLAUDE_PLUGIN_DATA is a loud failure, not an install into the wrong place", async () => {
    const npm = fakeNpm();
    await assert.rejects(installVersion("0.1.50", { env: { ...env, CLAUDE_PLUGIN_DATA: "" }, spawnFn: npm.spawnFn, npm: NPM }), /CLAUDE_PLUGIN_DATA is not set/);
    assert.deepEqual(npm.calls, []);
  });
});

describe("pruneInstalls (DX-4321)", () => {
  const T0 = new Date("2026-01-01T00:00:00Z");
  const T1 = new Date(T0.getTime() + 2 * STALE_INSTALL_MS);
  const now = T1.getTime() + 60_000; // T0 is over an hour before now; T1 is a minute before it

  function dirAt(name, when) {
    const dir = path.join(installRoot(), name);
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    utimesSync(dir, when, when);
    return dir;
  }

  test("removes every stage and every version but the kept ones once over an hour old; keeps the young, the record and anything else", () => {
    const oldVersion = dirAt("0.1.1", T0);
    const youngVersion = dirAt("0.1.2", T1);
    const running = dirAt("0.1.3", T0);
    const recorded = dirAt("0.1.4", T0);
    const orphanStage = dirAt(".stage-orphan", T0);
    const liveStage = dirAt(".stage-live", T1);
    const notAVersion = dirAt("notes", T0);
    recordAt("0.1.4");
    pruneInstalls(["0.1.3", "0.1.4"], { env, now });
    assert.equal(existsSync(oldVersion), false, "an old version directory is removed");
    assert.equal(existsSync(orphanStage), false, "a stage orphaned by a killed install is removed");
    for (const kept of [youngVersion, running, recorded, liveStage, notAVersion]) assert.ok(existsSync(kept), kept);
    assert.equal(recordedVersionOrNull(env), "0.1.4");
  });

  test("DX-4235: an old version a live process leases (another session's server or live reader) is kept; one whose leaseholder is gone is removed", () => {
    const leased = dirAt("0.1.1", T0);
    const abandoned = dirAt("0.1.2", T0);
    leaseVersion("0.1.1", { env, pid: 111 });
    leaseVersion("0.1.2", { env, pid: 222 });
    for (const v of ["0.1.1", "0.1.2"]) utimesSync(path.join(installRoot(), v), T0, T0);
    const asked = [];
    pruneInstalls([], { env, now, alive: (pid) => (asked.push(pid), pid === 111) });
    assert.ok(existsSync(leased), "a version a live process runs is never removed");
    assert.equal(existsSync(abandoned), false, "a lease whose process is gone holds nothing");
    assert.deepEqual(asked.sort(), [111, 222]);
  });

  test("DX-4235: a lease is released by its holder", () => {
    dirAt("0.1.1", T0);
    const release = leaseVersion("0.1.1", { env, pid: 111 });
    assert.deepEqual(readdirSync(path.join(installRoot(), "0.1.1", ".leases")), ["111"]);
    release();
    assert.deepEqual(readdirSync(path.join(installRoot(), "0.1.1", ".leases")), []);
  });

  test("DX-4235: an entry another session pruned first (gone between the listing and the stat) is skipped, not an error", () => {
    const gone = dirAt("0.1.1", T0);
    const old = dirAt("0.1.2", T0);
    const realStat = fs.statSync;
    const stat = mock.method(fs, "statSync", (p, ...rest) => {
      if (p === gone) {
        rmSync(gone, { recursive: true, force: true });
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
      }
      return realStat(p, ...rest);
    });
    try {
      pruneInstalls([], { env, now });
    } finally {
      stat.mock.restore();
    }
    assert.equal(existsSync(old), false, "the rest is still pruned");
  });
});

describe("renameRetrying: a rename Windows briefly refuses (DX-4235)", () => {
  const refusing = (codes) => {
    const calls = [];
    return {
      calls,
      renameSync: (from, to) => {
        calls.push([from, to]);
        const code = codes.shift();
        if (code !== undefined) throw Object.assign(new Error(code), { code });
      },
    };
  };

  test("each retryable refusal is retried after a wait that grows by the base each time, until it lands", () => {
    assert.deepEqual(RENAME_RETRYABLE_CODES, ["EPERM", "EBUSY", "EACCES"]);
    const fsApi = refusing(["EPERM", "EBUSY", "EACCES"]);
    const waits = [];
    assert.equal(renameRetrying("a", "b", fsApi, () => false, (ms) => waits.push(ms)), true);
    assert.equal(fsApi.calls.length, 4);
    assert.deepEqual(waits, [RENAME_RETRY_BASE_MS, 2 * RENAME_RETRY_BASE_MS, 3 * RENAME_RETRY_BASE_MS]);
  });

  test("any other error is thrown at once, with no wait", () => {
    const fsApi = refusing(["EXDEV"]);
    const waits = [];
    assert.throws(() => renameRetrying("a", "b", fsApi, () => false, (ms) => waits.push(ms)), { code: "EXDEV" });
    assert.deepEqual(waits, []);
  });

  test("a refusal that never ends is thrown after the last attempt", () => {
    const fsApi = refusing(Array(RENAME_RETRY_ATTEMPTS).fill("EBUSY"));
    const waits = [];
    assert.throws(() => renameRetrying("a", "b", fsApi, () => false, (ms) => waits.push(ms)), { code: "EBUSY" });
    assert.equal(fsApi.calls.length, RENAME_RETRY_ATTEMPTS);
    assert.equal(waits.length, RENAME_RETRY_ATTEMPTS - 1);
  });

  test("a refusal after a concurrent installer put its copy in place answers false and stops", () => {
    const fsApi = refusing(["EPERM"]);
    assert.equal(renameRetrying("a", "b", fsApi, () => true, () => assert.fail("no wait once settled")), false);
    assert.equal(fsApi.calls.length, 1);
  });
});

describe("startVersion: what the launcher starts the server from", () => {
  test("a recorded, installed version is answered with no registry request and no npm", async () => {
    recordAt("0.1.7");
    const bin = layDown("0.1.7");
    const npm = fakeNpm();
    assert.deepEqual(await startVersion({ env, spawnFn: npm.spawnFn, npm: NPM }), { version: "0.1.7", bin });
    assert.deepEqual(registry.requests(), []);
    assert.deepEqual(npm.calls, []);
  });

  test("a recorded version that is not installed is installed, still with no registry request, even when the registry has moved", async () => {
    recordAt("0.1.7");
    const npm = fakeNpm();
    const { version, bin } = await startVersion({ env, spawnFn: npm.spawnFn, npm: NPM });
    assert.equal(version, "0.1.7");
    assert.equal(bin, installedBin(dataDir, "0.1.7"));
    assert.equal(npm.calls[0].args.at(-1), SPEC("0.1.7"));
    assert.deepEqual(registry.requests(), []);
  });

  test("with nothing recorded it resolves the registry's latest, installs it, and only then records it", async () => {
    let recordedAtSpawn = "unset";
    const npm = fakeNpm("ok", () => (recordedAtSpawn = recordedVersionOrNull(env)));
    const { version, bin } = await startVersion({ env, spawnFn: npm.spawnFn, npm: NPM });
    assert.equal(version, "0.1.50");
    assert.ok(existsSync(bin));
    assert.equal(recordedAtSpawn, null, "nothing is recorded until the install succeeded");
    assert.equal(recordedVersionOrNull(env), "0.1.50");
    assert.deepEqual(registry.requests(), [LATEST_PATH]);
  });

  test("nothing recorded and the registry unreadable: one line naming the reason and that nothing can start; npm never runs", async () => {
    registry.setMode("status-500");
    const npm = fakeNpm();
    await assert.rejects(startVersion({ env, spawnFn: npm.spawnFn, npm: NPM }), (err) => {
      assert.match(err.message, /HTTP 500/);
      assert.match(err.message, /no .*version is recorded.*nothing that runs it can start/);
      oneLineOnly(err);
      return true;
    });
    assert.deepEqual(npm.calls, []);
    assert.equal(existsSync(recordFile()), false);
  });

  test("nothing recorded and the install fails: the install's line, and nothing is recorded", async () => {
    const npm = fakeNpm("fail");
    await assert.rejects(startVersion({ env, spawnFn: npm.spawnFn, npm: NPM }), /^Error: install_failed: /);
    assert.equal(recordedVersionOrNull(env), null);
  });
});

describe("refreshInstall: the background refresh", () => {
  test("the registry's latest moved A to B: B is installed into its own directory, then recorded; A's install is untouched", async () => {
    recordAt("0.1.7");
    const a = layDown("0.1.7");
    registry.setVersion("0.1.8");
    let recordedAtSpawn;
    const npm = fakeNpm("ok", () => (recordedAtSpawn = recordedVersionOrNull(env)));
    assert.equal(await refreshInstall({ env, spawnFn: npm.spawnFn, npm: NPM }), "0.1.8");
    assert.equal(recordedAtSpawn, "0.1.7", "the record moves only after B installed");
    assert.equal(recordedVersionOrNull(env), "0.1.8");
    assert.ok(existsSync(installedBin(dataDir, "0.1.8")));
    assert.equal(readFileSync(a, "utf8"), "installed 0.1.7", "the running version's install is untouched");
    assert.deepEqual(readdirSync(installRoot()).sort(), ["0.1.7", "0.1.8", "current"]);
  });

  test("an unchanged latest that is installed: no npm, the record stays", async () => {
    recordAt("0.1.50");
    layDown("0.1.50");
    const npm = fakeNpm();
    assert.equal(await refreshInstall({ env, spawnFn: npm.spawnFn, npm: NPM }), "0.1.50");
    assert.deepEqual(npm.calls, []);
    assert.equal(recordedVersionOrNull(env), "0.1.50");
  });

  test("a registry that cannot be read rejects and changes nothing", async () => {
    recordAt("0.1.7");
    registry.setMode("status-500");
    const npm = fakeNpm();
    await assert.rejects(refreshInstall({ env, spawnFn: npm.spawnFn, npm: NPM }), /HTTP 500/);
    assert.equal(recordedVersionOrNull(env), "0.1.7");
    assert.deepEqual(npm.calls, []);
  });

  test("a failed install of the new version rejects and keeps the record", async () => {
    recordAt("0.1.7");
    registry.setVersion("0.1.8");
    const npm = fakeNpm("fail");
    await assert.rejects(refreshInstall({ env, spawnFn: npm.spawnFn, npm: NPM }), /^Error: install_failed: /);
    assert.equal(recordedVersionOrNull(env), "0.1.7");
  });

  test("it prunes nothing itself: pruning is the launcher's separate step", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    recordAt("0.1.7");
    layDown("0.1.6");
    utimesSync(path.join(installRoot(), "0.1.6"), old, old);
    registry.setVersion("0.1.8");
    const npm = fakeNpm();
    await refreshInstall({ env, spawnFn: npm.spawnFn, npm: NPM });
    assert.deepEqual(readdirSync(installRoot()).sort(), ["0.1.6", "0.1.8", "current"]);
  });
});

// AC3 (DX-4321) — no shipped plugin file carries a version of the package. Which version runs is the registry's `latest`,
// recorded by the launcher; a literal here would be the hand-bumped pin that fell behind the published package five times.
describe("no shipped plugin file carries a package version literal", () => {
  /** The lines of `text` that put a version literal next to the package name. */
  function versionLiterals(text) {
    return text.split("\n").filter((line) => /@thehammer\/danx-dashboard-mcp@\d/.test(line) || (line.includes("danx-dashboard-mcp") && /\b\d+\.\d+\.\d+\b/.test(line)));
  }

  test("the scan itself catches the shapes a reintroduced pin takes", () => {
    for (const bad of [
      'export const DASHBOARD_MCP_PACKAGE = "@thehammer/danx-dashboard-mcp@0.1.220";',
      "// pinned: danx-dashboard-mcp 0.1.220",
      "npx -y @thehammer/danx-dashboard-mcp@1 event-text",
    ]) {
      assert.equal(versionLiterals(bad).length, 1, bad);
    }
    for (const fine of ["export const DASHBOARD_MCP_PACKAGE_NAME = \"@thehammer/danx-dashboard-mcp\";", "the danx-dashboard-mcp version is recorded", "plugin v0.12.4"]) {
      assert.deepEqual(versionLiterals(fine), [], fine);
    }
  });

  test("scripts, hooks, skills, agents, CLAUDE.md and README.md carry none (tests and fixtures are not shipped)", () => {
    const repoRoot = path.join(here, "..", "..");
    const shipped = [...listPluginFiles(repoRoot, "danxbot").map((rel) => path.join(repoRoot, "danxbot", rel)), path.join(repoRoot, "CLAUDE.md"), path.join(repoRoot, "README.md")];
    assert.ok(shipped.some((file) => file.endsWith(path.join("scripts", "lib", "dashboard-mcp-package.mjs"))), "the listing found the plugin's files");
    const hits = [];
    for (const file of shipped) {
      if (!existsSync(file) || /\.(png|jpg|ico)$/.test(file)) continue;
      for (const line of versionLiterals(readFileSync(file, "utf8"))) hits.push(`${path.relative(repoRoot, file)}: ${line.trim()}`);
    }
    assert.deepEqual(hits, []);
  });
});

// DX-3673 / DX-3811 / DX-4235 — the REAL registry and the REAL package, deliberately: a fake can never catch a drift
// between this plugin and what the registry publishes, which is the one thing these guard. A danxbot publish that moved the
// package's entry point would make every install end in install_incomplete; one that removed a subcommand this plugin
// still runs (`subagents-live`, subagents-live.mjs) reaches every session start at once. Both are caught here by a real,
// shell-free install of the registry's current `latest` (also the live proof that npm runs with no shell on this OS).
// Network dependent by design; slower than the rest of this file (a real npm install, ~5-20 s).
describe("the registry's current package, installed for real with no shell", { timeout: INSTALL_TIMEOUT_MS + 30_000 }, () => {
  let realData;
  let installed;
  before(async () => {
    realData = mkdtempSync(path.join(tmpdir(), "mcp-package-real-"));
    const realEnv = { ...process.env, CLAUDE_PLUGIN_DATA: realData };
    delete realEnv[REGISTRY_BASE_URL_ENV];
    installed = await startVersion({ env: realEnv });
  });
  after(() => rmSync(realData, { recursive: true, force: true }));

  test("its published entry point is the layout the plugin runs and subagents-live.mjs reads", () => {
    assert.equal(installed.bin, installedBin(realData, installed.version));
    assert.ok(existsSync(installed.bin), installed.bin);
  });

  test("it supports every subcommand this plugin invokes on it", () => {
    // An unknown subcommand makes the published entry point refuse with its own list: `... (the only ones are "a", "b", ...)`.
    const probe = spawnSync(process.execPath, [installed.bin, "__dx-3673-guard-probe__"], { encoding: "utf8" });
    assert.equal(probe.status, 2, `expected the package's own "unknown subcommand" refusal; got ${probe.status}: ${probe.stderr}`);
    const listed = [...probe.stderr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(
      listed.includes(LIVE_SUBCOMMAND),
      `${SPEC(installed.version)} does not support "${LIVE_SUBCOMMAND}", which subagents-live.mjs runs: a release removed it. Published: [${listed.join(", ")}]`,
    );
  });
});
