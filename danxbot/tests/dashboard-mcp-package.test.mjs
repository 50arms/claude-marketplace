// DX-4321 — scripts/lib/dashboard-mcp-package.mjs: the ONE module every consumer asks which
// version of `@thehammer/danx-dashboard-mcp` to run. The plugin carries no version literal:
// the registry's `latest` is resolved at session start, recorded under the plugin data dir and
// read back (no network) by every other hook. A fake registry (fixtures/fake-registry.mjs)
// stands in for npm; nothing here touches the network.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_MCP_PACKAGE_NAME,
  readRecordedVersion,
  refreshOrKeep,
  refreshRecordedVersion,
  registryUrl,
  resolveLatestVersion,
} from "../scripts/lib/dashboard-mcp-package.mjs";
import { listPluginFiles } from "../../scripts/write-integrity-manifest.mjs";
import { REGISTRY_BASE_URL_ENV, REGISTRY_TIMEOUT_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(here, "..", "scripts", "lib", "dashboard-mcp-package.mjs");
const LATEST_PATH = "/@thehammer%2Fdanx-dashboard-mcp/latest";

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

const recordFile = () => path.join(dataDir, "dashboard-mcp", "current");

function recordAt(version) {
  mkdirSync(path.dirname(recordFile()), { recursive: true });
  writeFileSync(recordFile(), `${version}\n`);
}

function runModule(args, extraEnv = {}) {
  return spawnSync(process.execPath, [MODULE, ...args], { encoding: "utf8", env: { ...env, ...extraEnv } });
}

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
    const started = Date.now();
    await assert.rejects(resolveLatestVersion({ env, timeoutMs: 300 }), (err) => {
      assert.ok(err.message.includes(LATEST_PATH), err.message);
      assert.match(err.message, /no answer within 300ms/);
      return true;
    });
    assert.ok(Date.now() - started < 5_000, "the bound, not the OS socket timeout, ended it");
  });

  test("the env timeout seam bounds the request when no timeout is passed", async () => {
    registry.setMode("hang");
    await assert.rejects(resolveLatestVersion({ env: { ...env, [REGISTRY_TIMEOUT_ENV]: "250" } }), /no answer within 250ms/);
  });
});

describe("recorded version", () => {
  test("the reader returns the recorded version, and null when nothing (or nothing valid) is recorded", () => {
    assert.equal(readRecordedVersion(env), null);
    recordAt("0.1.7");
    assert.equal(readRecordedVersion(env), "0.1.7");
    recordAt("not-a-version");
    assert.equal(readRecordedVersion(env), null, "a record that is not a strict x.y.z is no record");
  });

  test("the reader makes no registry request", () => {
    recordAt("0.1.7");
    readRecordedVersion(env);
    assert.deepEqual(registry.requests(), []);
  });

  test("a refresh records the registry's version under dashboard-mcp/current and leaves no temp file", async () => {
    assert.equal(await refreshRecordedVersion({ env }), "0.1.50");
    assert.equal(readFileSync(recordFile(), "utf8").trim(), "0.1.50");
    assert.deepEqual(readdirSync(path.dirname(recordFile())), ["current"]);
    registry.setVersion("0.1.51");
    await refreshRecordedVersion({ env });
    assert.equal(readRecordedVersion(env), "0.1.51");
    assert.deepEqual(readdirSync(path.dirname(recordFile())), ["current"]);
  });

  test("a failed refresh changes nothing: the previous record stays, whole", async () => {
    recordAt("0.1.7");
    registry.setMode("status-500");
    await assert.rejects(refreshRecordedVersion({ env }));
    assert.equal(readRecordedVersion(env), "0.1.7");
    assert.deepEqual(readdirSync(path.dirname(recordFile())), ["current"]);
  });

  test("the record is written by temp file + rename, so a reader never sees a partial one", async () => {
    // Read the record in a tight loop while refreshes replace it: every read must be a complete
    // strict version, never empty or truncated.
    recordAt("0.1.50");
    let stop = false;
    const seen = new Set();
    const reader = (async () => {
      while (!stop) {
        seen.add(readFileSync(recordFile(), "utf8"));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < 20; i += 1) {
      registry.setVersion(i % 2 === 0 ? "0.1.51" : "0.1.50");
      await refreshRecordedVersion({ env });
    }
    stop = true;
    await reader;
    for (const text of seen) assert.match(text, /^0\.1\.5[01]\n?$/, `a torn record was observable: ${JSON.stringify(text)}`);
  });

  test("two concurrent refreshes leave one valid file that agrees with the registry", async () => {
    const runs = [0, 1, 2, 3].map(
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [MODULE, "--refresh"], { env, stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.on("close", (code) => resolve({ code, out }));
        }),
    );
    const results = await Promise.all(runs);
    for (const r of results) {
      assert.equal(r.code, 0);
      assert.equal(r.out, `${DASHBOARD_MCP_PACKAGE_NAME}@0.1.50`);
    }
    assert.equal(readRecordedVersion(env), "0.1.50");
    assert.deepEqual(readdirSync(path.dirname(recordFile())), ["current"]);
  });
});

describe("refreshOrKeep", () => {
  test("refreshed: reports the new version", async () => {
    recordAt("0.1.7");
    assert.deepEqual(await refreshOrKeep({ env }), { version: "0.1.50", refreshed: true });
  });

  test("a failed refresh with a record keeps it and says why, naming the version still in use", async () => {
    recordAt("0.1.7");
    registry.setMode("status-500");
    const result = await refreshOrKeep({ env });
    assert.equal(result.version, "0.1.7");
    assert.equal(result.refreshed, false);
    assert.match(result.line, /could not refresh/);
    assert.match(result.line, /HTTP 500/);
    assert.match(result.line, /0\.1\.7/);
    assert.equal(result.line.includes("\n"), false, "ONE line");
  });

  test("a failed refresh with no record throws a line saying nothing will run", async () => {
    registry.setMode("status-500");
    await assert.rejects(refreshOrKeep({ env }), (err) => {
      assert.match(err.message, /no .*version is recorded/);
      assert.match(err.message, /HTTP 500/);
      assert.match(err.message, /nothing .*can start/);
      assert.equal(err.message.includes("\n"), false);
      return true;
    });
    assert.equal(existsSync(recordFile()), false);
  });
});

describe("CLI", () => {
  test("no args prints the recorded spec (no newline) and makes no registry request", () => {
    recordAt("0.1.7");
    const result = runModule([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${DASHBOARD_MCP_PACKAGE_NAME}@0.1.7`);
    assert.deepEqual(registry.requests(), []);
  });

  test("no args with no record resolves through the same function and records it", () => {
    const result = runModule([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${DASHBOARD_MCP_PACKAGE_NAME}@0.1.50`);
    assert.equal(readRecordedVersion(env), "0.1.50");
    assert.equal(registry.requests().length, 1);
  });

  test("no args, no record, registry down: exit 1, one stderr line, nothing on stdout", () => {
    registry.setMode("status-500");
    const result = runModule([]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.match(result.stderr, /nothing .*can start/);
  });

  test("--refresh moves the record to the registry's version: exit 0 and the new spec", () => {
    recordAt("0.1.7");
    const result = runModule(["--refresh"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${DASHBOARD_MCP_PACKAGE_NAME}@0.1.50`);
    assert.equal(readRecordedVersion(env), "0.1.50");
  });

  test("--refresh with the registry down and a record: exit 3, the recorded spec on stdout, ONE line on stderr", () => {
    recordAt("0.1.7");
    registry.setMode("status-500");
    const result = runModule(["--refresh"]);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, `${DASHBOARD_MCP_PACKAGE_NAME}@0.1.7`);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.match(result.stderr, /HTTP 500.*0\.1\.7/);
  });

  test("--refresh with the registry down and no record: exit 1, nothing on stdout, the line says nothing will run", () => {
    registry.setMode("status-500");
    const result = runModule(["--refresh"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /nothing .*can start/);
  });

  test("an unknown argument is refused, not read as a version", () => {
    const result = runModule(["--bogus"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
  });
});

// AC3 — no shipped plugin file carries a version of the package. Which version runs is the
// registry's `latest`, recorded at session start; a literal here would be the hand-bumped pin
// that fell behind the published package five times.
describe("no shipped plugin file carries a package version literal", () => {
  /** The lines of `text` that put a version literal next to the package name. */
  function versionLiterals(text) {
    return text.split("\n").filter((line) => /@thehammer\/danx-dashboard-mcp@\d/.test(line) || (line.includes("danx-dashboard-mcp") && /\b\d+\.\d+\.\d+\b/.test(line)));
  }

  test("the scan itself catches the shapes a reintroduced pin takes", () => {
    for (const bad of [
      'export const DASHBOARD_MCP_PACKAGE = "@thehammer/danx-dashboard-mcp@0.1.220";',
      "// pinned: danx-dashboard-mcp 0.1.220",
      "npx -y @thehammer/danx-dashboard-mcp@1 bridge",
    ]) {
      assert.equal(versionLiterals(bad).length, 1, bad);
    }
    for (const fine of ["export const DASHBOARD_MCP_PACKAGE_NAME = \"@thehammer/danx-dashboard-mcp\";", "the danx-dashboard-mcp version is recorded", "plugin v0.12.4"]) {
      assert.deepEqual(versionLiterals(fine), [], fine);
    }
  });

  test("scripts, hooks.json, skills, agents, CLAUDE.md and README.md carry none (tests and fixtures are not shipped)", () => {
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
