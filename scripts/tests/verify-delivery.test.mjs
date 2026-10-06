// scripts/tests/verify-delivery.test.mjs — post-delivery check for
// scripts/publish.sh (DX-3057). Runs scripts/verify-delivery.mjs for real
// via execFileSync against fs.mkdtempSync fixtures holding a fake
// installed_plugins.json + a fake plugin cache tree — mirrors
// check-injection-budget.test.mjs's style (real subprocess, real exit code,
// no mocking of fs internals).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "verify-delivery.mjs");

const MARKETPLACE = "50arms";
const PLUGIN = "danxbot";

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Writes installed_plugins.json with the given rows for PLUGIN@MARKETPLACE.
function writeInstalledFile(dir, entries) {
  const file = path.join(dir, "installed_plugins.json");
  const data = { plugins: { [`${PLUGIN}@${MARKETPLACE}`]: entries } };
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

// Creates <cacheRoot>/<plugin>/<version> dirs for each version given.
function writeCacheTree(cacheRoot, versions) {
  const pluginCachePath = path.join(cacheRoot, PLUGIN);
  fs.mkdirSync(pluginCachePath, { recursive: true });
  for (const v of versions) {
    fs.mkdirSync(path.join(pluginCachePath, v), { recursive: true });
  }
}

function run(installedFile, cacheRoot, expected) {
  try {
    const out = execFileSync(
      "node",
      [SCRIPT, installedFile, cacheRoot, MARKETPLACE, PLUGIN, expected],
      { encoding: "utf8" }
    );
    return { code: 0, stdout: out, stderr: "" };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("(a) every user + project row at the expected version, cache current → exit 0", () => {
  const tmp = mkTmpDir("verify-delivery-a-");
  const projectDir = path.join(tmp, "some-project");
  fs.mkdirSync(projectDir);
  const installedFile = writeInstalledFile(tmp, [
    { scope: "user", version: "1.2.3" },
    { scope: "project", version: "1.2.3", projectPath: projectDir },
  ]);
  const cacheRoot = path.join(tmp, "cache");
  writeCacheTree(cacheRoot, ["1.0.0", "1.2.3"]);

  const result = run(installedFile, cacheRoot, "1.2.3");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /confirmed installed/);
});

test("(b) one project-scope row on a stale version → exit 1, output names that row", () => {
  const tmp = mkTmpDir("verify-delivery-b-");
  const projectDir = path.join(tmp, "stale-project");
  fs.mkdirSync(projectDir);
  const installedFile = writeInstalledFile(tmp, [
    { scope: "user", version: "1.2.3" },
    { scope: "project", version: "1.2.2", projectPath: projectDir },
  ]);
  const cacheRoot = path.join(tmp, "cache");
  writeCacheTree(cacheRoot, ["1.2.3"]);

  const result = run(installedFile, cacheRoot, "1.2.3");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /project @ stale-project/);
  assert.match(result.stderr, /expected v1\.2\.3 but installed_plugins\.json shows '1\.2\.2'/);
});

test("(c) a row whose projectPath doesn't exist → SKIPPED, exit 0 when nothing else fails", () => {
  const tmp = mkTmpDir("verify-delivery-c-");
  const missingProjectPath = path.join(tmp, "does-not-exist");
  const installedFile = writeInstalledFile(tmp, [
    { scope: "user", version: "1.2.3" },
    { scope: "project", version: "0.0.1", projectPath: missingProjectPath },
  ]);
  const cacheRoot = path.join(tmp, "cache");
  writeCacheTree(cacheRoot, ["1.2.3"]);

  const result = run(installedFile, cacheRoot, "1.2.3");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /SKIPPED \(project path missing/);
});

test("(d) the newest cache dir behind the expected version → exit 1", () => {
  const tmp = mkTmpDir("verify-delivery-d-");
  const installedFile = writeInstalledFile(tmp, [{ scope: "user", version: "1.2.3" }]);
  const cacheRoot = path.join(tmp, "cache");
  writeCacheTree(cacheRoot, ["1.2.2"]);

  const result = run(installedFile, cacheRoot, "1.2.3");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /MISMATCH: expected v1\.2\.3 but newest cache dir/);
});
