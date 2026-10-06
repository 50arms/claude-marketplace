#!/usr/bin/env node
// DX-3997: the plugin integrity launcher. Every hook command in hooks.json runs through it:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" [--via stdout|rewake] <script> [args...]
//
// WHY. On 2026-10-01 a machine crash left six cached plugin files the same size but all NUL
// bytes. Every hook then failed with nothing shown anywhere, so the
// operator's answer to a card went unseen for hours. This file is the one thing that must not depend on any file it
// checks: it imports only node builtins and stays small.
//
// WHAT IT DOES, on every hook run, before the hook's script starts:
//   1. Hashes every file listed in `integrity-manifest.json` (written by
//      scripts/write-integrity-manifest.mjs at publish; the plugin's own sha256 per file).
//   2. A mismatching (zeroed, truncated, missing) file is restored from the marketplace
//      clone (`~/.claude/plugins/marketplaces/<marketplace>/<plugin>`), but only a clone file
//      whose own hash equals the manifest entry, so a clone at another commit, or itself
//      damaged, is never copied in. An unreadable manifest is restored from the clone only
//      when the clone's plugin.json version equals this cache directory's version.
//   3. Anything left unrestorable is reported, loudly and without spamming:
//        --via stdout   the hook's stdout reaches the model (SessionStart, UserPromptSubmit):
//                       the warning is printed there, once per WARN_INTERVAL_MS per problem.
//        --via rewake   an asyncRewake hook: when its own script cannot run, exit 2 with the
//                       warning on stderr, which wakes the session.
//        (no flag)      stderr only; the hook exits 1 when its own script cannot run.
//   4. Runs the script (`.sh` under bash, `.mjs` under this node) with the hook's stdin and
//      args, stdio inherited, and exits with its code. A script that is itself unrestorable
//      is never run.
//
// A zeroed launch.mjs cannot repair itself: the two hooks that reach the model print their
// own fallback line when the launcher fails to run (see hooks.json).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These two constants are also in scripts/write-integrity-manifest.mjs (the launcher may import only node
// builtins, so it cannot share them); launch.test.mjs pins the two copies together.
export const MANIFEST_FILE = "integrity-manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;
/** One warning per distinct problem per window, however many hooks fire in it. */
export const WARN_INTERVAL_MS = 10 * 60 * 1000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** sha256 of a file, or null when it cannot be read (missing counts as damaged). */
function hashFile(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function isSafeRel(rel) {
  return typeof rel === "string" && rel !== "" && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

/** The parsed manifest at `file`, or `{ error }` naming why it cannot be trusted. */
function loadManifest(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `cannot read ${path.basename(file)} (${err.code ?? err.name})` };
  }
  const files = parsed?.files;
  const entries = files && typeof files === "object" ? Object.entries(files) : [];
  if (
    parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    entries.length === 0 ||
    !entries.every(([rel, hash]) => isSafeRel(rel) && /^[0-9a-f]{64}$/.test(hash))
  ) {
    return { error: `${path.basename(file)} is not a schema-${MANIFEST_SCHEMA_VERSION} manifest` };
  }
  return { files };
}

/**
 * `~/.claude/plugins/marketplaces/<marketplace>/<plugin>` for a root of the form
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`; null for any other layout (a dev checkout).
 */
function cloneDirFor(root) {
  const pluginDir = path.dirname(root);
  const marketplaceDir = path.dirname(pluginDir);
  const cacheDir = path.dirname(marketplaceDir);
  if (path.basename(cacheDir) !== "cache") return null;
  return path.join(path.dirname(cacheDir), "marketplaces", path.basename(marketplaceDir), path.basename(pluginDir));
}

function copyAtomic(from, to, expectedHash) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, fs.readFileSync(from));
  fs.renameSync(tmp, to);
  return hashFile(to) === expectedHash;
}

/** Restores `rel` from `clone` when the clone's copy hashes to `expectedHash`. */
function restoreFromClone(root, clone, rel, expectedHash) {
  if (clone === null) return false;
  const source = path.join(clone, rel);
  if (hashFile(source) !== expectedHash) return false;
  try {
    return copyAtomic(source, path.join(root, rel), expectedHash);
  } catch {
    return false; // read-only cache, disk full: the file stays damaged and is reported
  }
}

/** The manifest, restored from the clone when it is unreadable and the clone is this very version. */
function manifestWithRepair(root, clone) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  const loaded = loadManifest(manifestPath);
  if (loaded.files) return { files: loaded.files, restoredManifest: false };
  if (clone === null) return { error: loaded.error };
  let cloneVersion;
  try {
    cloneVersion = JSON.parse(fs.readFileSync(path.join(clone, ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return { error: loaded.error };
  }
  const cloneManifest = path.join(clone, MANIFEST_FILE);
  if (cloneVersion !== path.basename(root) || loadManifest(cloneManifest).files === undefined) return { error: loaded.error };
  try {
    copyAtomic(cloneManifest, manifestPath, hashFile(cloneManifest));
  } catch {
    return { error: loaded.error };
  }
  const restored = loadManifest(manifestPath);
  return restored.files ? { files: restored.files, restoredManifest: true } : { error: restored.error };
}

/**
 * Verify every manifest file under `root`, restoring what the marketplace clone can restore.
 * `{ manifestOk: false, error }` when there is no manifest to verify against.
 */
export function verifyAndRepair({ root }) {
  const clone = cloneDirFor(root);
  const manifest = manifestWithRepair(root, clone);
  if (manifest.error !== undefined) return { manifestOk: false, error: manifest.error, restored: [], unrestorable: [] };
  const restored = manifest.restoredManifest ? [MANIFEST_FILE] : [];
  const unrestorable = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    if (hashFile(path.join(root, rel)) === expected) continue;
    (restoreFromClone(root, clone, rel, expected) ? restored : unrestorable).push(rel);
  }
  return { manifestOk: true, files: manifest.files, restored, unrestorable };
}

/**
 * True for exactly one caller per `WARN_INTERVAL_MS` per `signature` (an exclusive-create marker in
 * `dir`, whose mtime is the last warning). A marker that cannot be read or written never silences a warning.
 */
export function claimWarning(signature, { dir = os.tmpdir(), now = Date.now() } = {}) {
  const marker = path.join(dir, `danxbot-integrity-${sha256(signature).slice(0, 16)}`);
  try {
    fs.writeFileSync(marker, "", { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") return true;
  }
  try {
    if (now - fs.statSync(marker).mtimeMs < WARN_INTERVAL_MS) return false;
    fs.utimesSync(marker, new Date(now), new Date(now));
  } catch {
    /* a marker that vanished or cannot be touched: warn */
  }
  return true;
}

/** The one repair instruction every integrity message carries; hooks.json's fallback lines say the same (launch.test.mjs pins both). */
export const INTEGRITY_FIX =
  "Fix: run `claude plugin uninstall danxbot --keep-data`, then `claude plugin install danxbot` (add `--config dashboard_url=<address>` if you had set a custom dashboard address, which a reinstall forgets), then restart the session.";

function warningText(root, result) {
  const head = "[danxbot plugin] INTEGRITY FAILURE:";
  if (!result.manifestOk) {
    return `${head} the integrity manifest is unreadable (${result.error}), so no plugin file in ${root} could be verified; danxbot hooks may be silently broken. ${INTEGRITY_FIX}`;
  }
  const names = result.unrestorable.slice(0, 5).join(", ") + (result.unrestorable.length > 5 ? `, and ${result.unrestorable.length - 5} more` : "");
  return `${head} ${result.unrestorable.length} plugin file(s) are corrupt and could not be restored from the marketplace clone (${names}); danxbot hooks may not work and plan events may not reach this session. ${INTEGRITY_FIX}`;
}

function parseArgs(argv) {
  let via = null;
  let rest = argv;
  if (rest[0] === "--via") {
    via = rest[1];
    rest = rest.slice(2);
  }
  if ((via !== null && via !== "stdout" && via !== "rewake") || rest.length === 0) return null;
  return { via, script: rest[0], args: rest.slice(1) };
}

function interpreterFor(script) {
  return script.endsWith(".sh") ? "bash" : process.execPath;
}

export async function main(argv, { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") } = {}) {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write("usage: launch.mjs [--via stdout|rewake] <script relative to the plugin> [args...]\n");
    return 2;
  }
  const { via, script, args } = parsed;
  const target = path.resolve(root, script);
  const rel = path.relative(root, target).split(path.sep).join("/");
  if (!isSafeRel(rel)) {
    process.stderr.write(`launch.mjs: ${script} is outside the plugin\n`);
    return 1;
  }

  const result = verifyAndRepair({ root });
  if (result.restored.length > 0) {
    process.stderr.write(`[danxbot plugin] repaired ${result.restored.length} corrupt plugin file(s) from the marketplace clone: ${result.restored.join(", ")}\n`);
  }
  if (result.manifestOk && result.files[rel] === undefined) {
    process.stderr.write(`launch.mjs: ${rel} is not in the integrity manifest, refusing to run it\n`);
    return 1;
  }

  const problem = !result.manifestOk || result.unrestorable.length > 0;
  const targetBroken = result.unrestorable.includes(rel);
  if (problem) {
    const text = warningText(root, result);
    const signature = `${root}|${process.env.CLAUDE_CODE_SESSION_ID ?? ""}|${result.manifestOk ? result.unrestorable.join(",") : "manifest"}`;
    process.stderr.write(`${text}\n`);
    if (via === "stdout" && claimWarning(signature)) process.stdout.write(`${text}\n`);
    if (targetBroken) {
      if (via === "rewake") return claimWarning(`${signature}|rewake`) ? 2 : 0;
      return via === "stdout" ? 0 : 1;
    }
  }

  return new Promise((resolve) => {
    const child = spawn(interpreterFor(rel), [target, ...args], { stdio: "inherit" });
    child.on("error", (err) => {
      process.stderr.write(`launch.mjs: could not start ${rel}: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
