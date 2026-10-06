#!/usr/bin/env node
//
// audit-package.mjs - DX-4565.
//
// Publish-time gate for a plugin shipped as an npm package (`@50arms/claude-plugin`). It audits
// what `npm pack` would actually put in the tarball, never the source tree, so a file the
// `files` list leaks or forgets is caught:
//   1. the tarball holds exactly the integrity manifest's files, plus the manifest and
//      package.json (the launcher hashes the manifest's files at every hook run, so a file
//      missing from the tarball is a corrupt install on every machine);
//   2. package.json and .claude-plugin/plugin.json carry the same version (Claude Code takes
//      the installed version from plugin.json; npm takes it from package.json);
// The text every user reads is scanned for author-specific names by scripts/check-general-audience.mjs
// (DX-4551), which publish-npm.sh runs first; this file holds no second list of banned names.
//
// USAGE  node scripts/audit-package.mjs <plugin>        exit 0 clean, 1 with every problem listed

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANIFEST_FILE } from "./write-integrity-manifest.mjs";

/** The files `npm pack` would ship for `pluginDir`, relative with `/` separators, sorted. */
export function packedFiles(pluginDir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: pluginDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out)[0].files.map((f) => f.path.split(path.sep).join("/")).sort();
}

/** Every problem with `pluginDir` as a package; an empty array is a clean audit. */
export function auditPackage(pluginDir, packed = packedFiles(pluginDir)) {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, MANIFEST_FILE), "utf8"));
  const expected = new Set([...Object.keys(manifest.files), MANIFEST_FILE, "package.json"]);
  for (const f of packed) if (!expected.has(f)) problems.push(`the tarball ships ${f}, which the integrity manifest does not list`);
  for (const f of expected) if (!packed.includes(f)) problems.push(`the tarball omits ${f}, which the integrity manifest lists`);

  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
  if (pkg.version !== plugin.version) problems.push(`package.json version ${pkg.version} differs from plugin.json version ${plugin.version}`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const plugin = process.argv[2];
  if (!plugin) {
    console.error("usage: audit-package.mjs <plugin>");
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = auditPackage(path.join(repoRoot, plugin));
  if (problems.length > 0) {
    for (const p of problems) console.error(`audit-package: ${p}`);
    process.exit(1);
  }
  console.log(`audit-package: ${plugin} is a clean package`);
}
