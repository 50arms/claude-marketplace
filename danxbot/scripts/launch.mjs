#!/usr/bin/env node
// DX-3997: the plugin integrity launcher. Every hook command in hooks.json runs through it:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" [--via stdout|rewake] <script> [args...]
//
// WHY. On 2026-10-01 a machine crash left six cached plugin files the same size but all NUL
// bytes. Every hook then failed with nothing shown anywhere, and the plan event bridge's
// watchdog sat in a corrupted file, so nothing restarted it; the operator's answer to a card
// went unseen for hours. This file is the one thing that must not depend on any file it
// checks: it imports only node builtins and stays small.
//
// WHAT IT DOES, on every hook run, before the hook's script starts:
//   1. Hashes every file listed in `integrity-manifest.json` (written by
//      scripts/write-integrity-manifest.mjs at publish; the plugin's own sha256 per file).
//   2. Reports anything that mismatches (zeroed, truncated, missing) or an unreadable manifest,
//      loudly and without spamming:
//        --via stdout   the hook's stdout reaches the model (SessionStart, UserPromptSubmit):
//                       the warning is printed there, once per WARN_INTERVAL_MS per problem.
//        --via rewake   an asyncRewake hook: when its own script is corrupt, exit 2 with the
//                       warning on stderr, which wakes the session.
//        (no flag)      stderr only; the hook exits 1 when its own script is corrupt.
//      The plugin is installed from npm, so no second copy exists to restore from: the repair
//      is a reinstall, which the warning names.
//   3. Runs the script (`.sh` under bash, `.mjs` under this node) with the hook's stdin and
//      args, stdio inherited, and exits with its code. A corrupt script is never run.
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
 * Verify every manifest file under `root`: `{ manifestOk: true, files, corrupt }` (`corrupt` lists the
 * mismatching, truncated or missing files), or `{ manifestOk: false, error, corrupt: [] }` when there is no manifest to verify against.
 */
export function verifyManifest({ root }) {
  const manifest = loadManifest(path.join(root, MANIFEST_FILE));
  if (manifest.error !== undefined) return { manifestOk: false, error: manifest.error, corrupt: [] };
  const corrupt = Object.entries(manifest.files)
    .filter(([rel, expected]) => hashFile(path.join(root, rel)) !== expected)
    .map(([rel]) => rel);
  return { manifestOk: true, files: manifest.files, corrupt };
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

/** The one repair instruction every integrity message carries; hooks.json's fallback line and bridge-watchdog.mjs say the same (launch.test.mjs pins all three). */
export const INTEGRITY_FIX =
  "Fix: run `claude plugin uninstall danxbot@50arms --keep-data`, then `claude plugin install danxbot@50arms` (add `--config dashboard_url=<address>` if you had set a custom dashboard address, which a reinstall forgets), then restart the session.";

function warningText(root, result) {
  const head = "[danxbot plugin] INTEGRITY FAILURE:";
  if (!result.manifestOk) {
    return `${head} the integrity manifest is unreadable (${result.error}), so no plugin file in ${root} could be verified; danxbot hooks may be silently broken. ${INTEGRITY_FIX}`;
  }
  const names = result.corrupt.slice(0, 5).join(", ") + (result.corrupt.length > 5 ? `, and ${result.corrupt.length - 5} more` : "");
  return `${head} ${result.corrupt.length} plugin file(s) are corrupt (${names}); danxbot hooks, including the plan event bridge, may not work and plan events may not reach this session. ${INTEGRITY_FIX}`;
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

  const result = verifyManifest({ root });
  if (result.manifestOk && result.files[rel] === undefined) {
    process.stderr.write(`launch.mjs: ${rel} is not in the integrity manifest, refusing to run it\n`);
    return 1;
  }

  const problem = !result.manifestOk || result.corrupt.length > 0;
  const targetBroken = result.corrupt.includes(rel);
  if (problem) {
    const text = warningText(root, result);
    const signature = `${root}|${process.env.CLAUDE_CODE_SESSION_ID ?? ""}|${result.manifestOk ? result.corrupt.join(",") : "manifest"}`;
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
