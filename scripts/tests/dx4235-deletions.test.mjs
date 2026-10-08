// DX-4235 (R-1): the danxbot plugin's command hooks, their integrity launcher and its hash manifest, the session-start install
// script and the package module's CLI are gone. A name of any of them left in the plugin, the repo scripts or the docs is a
// reference to something that no longer exists, so this test finds none.
//
// Each needle is spelled in pieces, so this file's own source never contains one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const NEEDLES = [
  ["launch", "mjs"].join("."),
  ["integrity", "manifest"].join("-"),
  ["ensure", "dashboard", "mcp"].join("-"),
  ["claim", "Warning"].join(""),
  ["EXIT", "REFRESH", "FAILED", "KEPT"].join("_"),
  ["--", "via"].join(""),
  ["--", "refresh"].join(""),
];

const SCANNED = ["danxbot", "scripts", "CLAUDE.md", "README.md"];

/** Files a commit of this checkout would hold under SCANNED (tracked plus untracked-not-ignored, minus deleted ones). */
function scannedFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCANNED], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((rel) => rel !== "" && fs.existsSync(path.join(REPO_ROOT, rel)));
}

test("DX-4235: no file in the plugin, the repo scripts or the docs names a deleted hook script, the launcher, its manifest or the package CLI", () => {
  const files = scannedFiles();
  assert.ok(files.includes("danxbot/hooks/register.tsx") && files.includes("CLAUDE.md"), "the scan reaches the plugin and the docs");
  const hits = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const needle of NEEDLES) if (line.includes(needle)) hits.push(`${rel}:${i + 1}: ${needle}`);
    });
  }
  assert.deepEqual(hits, []);
});
