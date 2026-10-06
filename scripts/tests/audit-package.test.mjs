// scripts/audit-package.mjs and the danxbot npm package shape - DX-4565.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditPackage, packedFiles } from "../audit-package.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...p), "utf8"));

test("the danxbot package, as npm would pack it, audits clean", () => {
  // the committed manifest's file list must match what npm packs: regenerate it (scripts/write-integrity-manifest.mjs) after adding a file
  assert.deepEqual(auditPackage(path.join(REPO_ROOT, "danxbot")), []);
});

test("the package ships no tests and every `files` entry exists", () => {
  const pkg = read("danxbot", "package.json");
  for (const entry of pkg.files) assert.ok(fs.existsSync(path.join(REPO_ROOT, "danxbot", entry)), `${entry} is listed in files but missing`);
  assert.ok(!packedFiles(path.join(REPO_ROOT, "danxbot")).some((f) => f.startsWith("tests/")));
});

test("the package is @50arms/claude-plugin, public, at plugin.json's version", () => {
  const pkg = read("danxbot", "package.json");
  assert.equal(pkg.name, "@50arms/claude-plugin");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.version, read("danxbot", ".claude-plugin", "plugin.json").version);
});

test("the marketplace skeleton lists danxbot from the npm package, under the name the install commands use", () => {
  const mp = read("50arms-marketplace", ".claude-plugin", "marketplace.json");
  assert.equal(mp.name, "50arms");
  assert.deepEqual(mp.plugins.map((p) => [p.name, p.source]), [["danxbot", { source: "npm", package: read("danxbot", "package.json").name }]]);
  assert.ok(Object.keys(mp.plugins[0].source).every((k) => ["source", "package"].includes(k)), "no version pin: plugin.json's version drives updates");
});

/** A throwaway one-file plugin dir with a manifest, to feed `auditPackage` a synthetic tarball listing. */
function tinyPlugin({ pkgVersion = "1.0.0" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-package-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/t", version: pkgVersion }));
  fs.writeFileSync(path.join(dir, "scripts", "a.mjs"), "// fine\n");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "leak.mjs"), "// not meant to ship\n");
  return dir;
}
function manifestFor(dir, files) {
  fs.writeFileSync(path.join(dir, "integrity-manifest.json"), JSON.stringify({ schemaVersion: 1, files: Object.fromEntries(files.map((f) => [f, "x"])) }));
}

test("a version mismatch, a leaked file and an omitted file are each reported", () => {
  const dir = tinyPlugin({ pkgVersion: "2.0.0" });
  try {
    manifestFor(dir, [".claude-plugin/plugin.json", "scripts/a.mjs", "scripts/missing.mjs"]);
    const problems = auditPackage(dir, ["integrity-manifest.json", "package.json", ".claude-plugin/plugin.json", "scripts/a.mjs", "tests/leak.mjs"]);
    assert.ok(problems.some((p) => /ships tests\/leak\.mjs/.test(p)), problems.join("\n"));
    assert.ok(problems.some((p) => /omits scripts\/missing\.mjs/.test(p)), problems.join("\n"));
    assert.ok(problems.some((p) => /version 2\.0\.0 differs/.test(p)), problems.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
