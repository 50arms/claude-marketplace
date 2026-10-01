// DX-3997 — scripts/write-integrity-manifest.mjs: which files are hashed, and that the output is deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPluginFiles, writeManifest, MANIFEST_FILE } from "../write-integrity-manifest.mjs";

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-manifest-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  put("p/scripts/a.mjs", "a\n");
  put("p/scripts/lib/b.mjs", "b\n");
  put("p/hooks/hooks.json", "{}\n");
  put("p/tests/a.test.mjs", "test\n");
  put("p/node_modules/x/index.js", "x\n");
  put("p/ignored.log", "ignored\n");
  put(".gitignore", "*.log\n");
  put("other/c.mjs", "c\n");
  execFileSync("git", ["add", "p/scripts/a.mjs"], { cwd: repo });
  return { repo, put };
}

test("lists tracked and untracked-not-ignored files of the plugin only, minus tests, node_modules and the manifest", () => {
  const { repo, put } = makeRepo();
  put(`p/${MANIFEST_FILE}`, "{}\n");
  assert.deepEqual(listPluginFiles(repo, "p"), ["hooks/hooks.json", "scripts/a.mjs", "scripts/lib/b.mjs"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("writes a sorted schema-1 manifest of sha256 hashes, identical on a second run", () => {
  const { repo } = makeRepo();
  const manifest = writeManifest(repo, "p");
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest.files), ["hooks/hooks.json", "scripts/a.mjs", "scripts/lib/b.mjs"]);
  assert.equal(manifest.files["scripts/a.mjs"], createHash("sha256").update("a\n").digest("hex"));
  const first = fs.readFileSync(path.join(repo, "p", MANIFEST_FILE), "utf8");
  writeManifest(repo, "p");
  assert.equal(fs.readFileSync(path.join(repo, "p", MANIFEST_FILE), "utf8"), first);
  fs.rmSync(repo, { recursive: true, force: true });
});
