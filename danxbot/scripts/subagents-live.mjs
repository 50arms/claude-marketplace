#!/usr/bin/env node
// DX-4508 — the plan pane's live sub-agent reader: `node <plugin root>/scripts/subagents-live.mjs <main transcript .jsonl>`.
//
// WHY A SCRIPT. The pane (hooks/register.tsx, a hooks module with no Node) starts this with `$.process.spawn` while its session has a
// running sub-agent, and reads its stdout. A hooks module is never told the plugin's data directory (CLAUDE_PLUGIN_DATA reaches
// command hooks only), so this script finds it from its own location, reads the recorded danx-dashboard-mcp version through the one
// module that owns that record (lib/dashboard-mcp-package.mjs), and runs that installed version's `subagents-live` subcommand IN
// THIS PROCESS. One process: the module's kill of this child stops the subcommand with it, never leaving a grandchild running.
//
// THE CONTRACT. stdout is the subcommand's own (`{"subagents":[...]}` lines; packages/danx-dashboard-mcp/src/subagents-live.ts in
// danxbot). A failure to start prints ONE line naming the reason on stderr and exits 1; the pane shows it. Nothing is installed
// here: ensure-dashboard-mcp.sh --prewarm installs the recorded version at every session start.
//
// THE PARENT. The engine kills this child when the module stops it or unloads. A session process that dies without unloading
// (a crash, a killed app) kills nothing. On Windows the subcommand sees its stdout close within a moment (measured 2026-10-04: a
// force-killed parent's reader exited in ~0.3 s), but on Linux and macOS a closed pipe shows only at the next write, which a quiet
// session never makes, so this script also exits once the process that started it is gone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DASHBOARD_MCP_PACKAGE_NAME, requireRecordedVersion } from "./lib/dashboard-mcp-package.mjs";

export const LIVE_SUBCOMMAND = "subagents-live";

/** How often the starting process is checked for: a stranded reader lingers at most this long. */
export const PARENT_CHECK_MS = 5_000;

/**
 * The plugin's data directory by Claude Code's own layout: a marketplace install's root is
 * `<plugins>/cache/<marketplace>/<plugin>/<version>` and its data directory `<plugins>/data/<plugin>-<marketplace>` (checked on this
 * machine, 2026-10-04: `...\plugins\cache\newms-plugins\danxbot\0.12.35` -> `...\plugins\data\danxbot-newms-plugins`). A root of any
 * other shape (a `--plugin-dir` load) has no data directory this can name: the answer is the reason, never a guess.
 */
export function pluginDataDir(root) {
  const pluginDir = path.dirname(path.resolve(root));
  const marketplaceDir = path.dirname(pluginDir);
  const cacheDir = path.dirname(marketplaceDir);
  if (path.basename(cacheDir) !== "cache") {
    return { reason: `the plugin is not loaded from a marketplace install (${root}), so its data directory is unknown` };
  }
  return { dir: path.join(path.dirname(cacheDir), "data", `${path.basename(pluginDir)}-${path.basename(marketplaceDir)}`) };
}

/** A version's installed entry point: the one layout ensure-dashboard-mcp.sh installs (`BIN_REL`). */
export function installedBin(dataDir, version) {
  return path.join(dataDir, "dashboard-mcp", version, "node_modules", ...DASHBOARD_MCP_PACKAGE_NAME.split("/"), "dist", "index.js");
}

/** The installed entry point of the recorded version for the plugin at `root`, or the reason there is none. */
export function resolveLiveBin(root) {
  const data = pluginDataDir(root);
  if ("reason" in data) return { ok: false, reason: data.reason };
  let version;
  try {
    version = requireRecordedVersion({ CLAUDE_PLUGIN_DATA: data.dir });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const bin = installedBin(data.dir, version);
  if (!fs.existsSync(bin)) return { ok: false, reason: `${DASHBOARD_MCP_PACKAGE_NAME} ${version} is not installed at ${bin}` };
  return { ok: true, bin };
}

/** Whether a process is still there (signal 0 checks without signalling); one that exists but may not be signalled is there. */
export function isAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Calls `onGone` once `pid` is gone, checking every `intervalMs`; the timer never keeps the process alive on its own. */
export function watchParent(pid, onGone, { intervalMs = PARENT_CHECK_MS, kill = process.kill, setIntervalFn = setInterval } = {}) {
  const timer = setIntervalFn(() => {
    if (!isAlive(pid, kill)) onGone();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const resolved = resolveLiveBin(root);
  if (!resolved.ok) {
    process.stderr.write(`${resolved.reason}\n`);
    process.exit(1);
  }
  watchParent(process.ppid, () => process.exit(0));
  // The package's entry point runs a subcommand only when it is the process's own script (its `isEntrypointModule` reads
  // `process.argv[1]`): it is handed exactly the argv `node <bin> subagents-live <transcript>` would give it.
  process.argv = [process.argv[0], resolved.bin, LIVE_SUBCOMMAND, ...process.argv.slice(2)];
  await import(pathToFileURL(resolved.bin).href);
}

// Run as a script only: `import.meta.url` is the real path, so argv[1] is resolved through links (a junctioned plugin root) first.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
