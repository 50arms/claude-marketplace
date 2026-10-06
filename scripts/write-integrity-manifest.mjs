#!/usr/bin/env node
//
// write-integrity-manifest.mjs — DX-3997.
//
// Writes `<plugin>/integrity-manifest.json`: the sha256 of every file a plugin
// ships (except its tests and the manifest itself). The plugin's own launcher
// (`<plugin>/scripts/launch.mjs`) checks this manifest before running any hook,
// so a cache copy a machine crash left zeroed or truncated is reported loudly, with
// the reinstall that repairs it, instead of silently killing the hook.
//
// WHEN IT RUNS. `scripts/publish.sh` runs it twice for every plugin that ships a
// `scripts/launch.mjs`: before its injection-budget check (that check runs every
// plugin's hooks, and a stale manifest would make each print a false INTEGRITY
// FAILURE), and again after the version bump, before the bump commit (the bumped
// `.claude-plugin/plugin.json` is itself a hashed file, so the manifest is
// regenerated last). Run it by hand to inspect the output; never hand-edit it.
//
// FILE LIST. `git ls-files --cached --others --exclude-standard` over the plugin
// dir: exactly what `git add <plugin>/` would commit, so the manifest and the
// commit can never disagree about which files exist.
//
// USAGE  node scripts/write-integrity-manifest.mjs <plugin>

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Also in danxbot/scripts/launch.mjs, which may import only node builtins; launch.test.mjs pins the two copies together.
export const MANIFEST_FILE = "integrity-manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;
/** Directories under a plugin that are never part of the runtime install a hook depends on. */
const EXCLUDED_TOP_DIRS = new Set(["tests", "node_modules"]);

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The plugin's shipped files, as paths relative to the plugin dir, with `/` separators, sorted. */
export function listPluginFiles(repoRoot, plugin) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", plugin], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  }).toString("utf8");
  return out
    .split("\0")
    .filter((p) => p !== "")
    .map((p) => p.slice(plugin.length + 1))
    .filter((rel) => rel !== MANIFEST_FILE && !EXCLUDED_TOP_DIRS.has(rel.split("/")[0]))
    .filter((rel) => fs.existsSync(path.join(repoRoot, plugin, rel)))
    .sort();
}

/** The manifest object for `relFiles` of `pluginDir`. Keys are sorted, so the output is deterministic. */
export function buildManifest(pluginDir, relFiles) {
  const files = {};
  for (const rel of [...relFiles].sort()) files[rel] = sha256File(path.join(pluginDir, rel));
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, files };
}

export function writeManifest(repoRoot, plugin) {
  const pluginDir = path.join(repoRoot, plugin);
  const manifest = buildManifest(pluginDir, listPluginFiles(repoRoot, plugin));
  fs.writeFileSync(path.join(pluginDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const plugin = process.argv[2];
  if (!plugin) {
    console.error("usage: write-integrity-manifest.mjs <plugin>");
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = writeManifest(repoRoot, plugin);
  console.log(`${plugin}/${MANIFEST_FILE}: ${Object.keys(manifest.files).length} files hashed`);
}
