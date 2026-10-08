// The ONE module that owns `@thehammer/danx-dashboard-mcp` for this plugin: which version runs (DX-4321) and installing it
// (DX-3811, DX-4235). Its callers: the plugin's MCP server launcher (dashboard-mcp-server.mjs), which starts the server
// from the recorded version and refreshes the record; subagents-live.mjs, which runs the recorded, installed version.
// This file carries NO version literal.
//
// WHICH VERSION. The npm registry's `latest` for the package, recorded in `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current`
// (temp file + rename, so a reader never sees a partial one). The launcher starts the server from the recorded version at
// once (`startVersion`: it resolves from the registry only when nothing is recorded), then refreshes the record from the
// registry while the server runs (`refreshInstall`). A danxbot publish therefore reaches the next session start with no
// plugin release and no added start latency.
//
// WHY EXACT, NOT `latest` AT RUN TIME (DX-3392): `npx -y` never re-checks the registry once a version is cached, so an
// unpinned spec would keep serving whatever this machine cached first. The plugin runs an exact version; it reads which
// one instead of having it typed in.
//
// WHERE (DX-3811). `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/<version>/node_modules/@thehammer/danx-dashboard-mcp/dist/index.js`,
// one directory per version, run with plain `node`, never through a cold `npx -y` (measured 2026-10-01: npx paid ~1.6 s
// warm and ~4 s cold before the package started; the installed copy ran end to end in 0.6 s).
//
// HOW IT INSTALLS (DX-4235: node, no bash, no shell). npm installs into its own staging directory and only a complete,
// verified install is renamed into place, so no reader ever sees a half-written one. `renameSync` refuses a destination
// that already holds an install, so the loser of two sessions installing at once discards its copy and uses the winner's.
// The install is bounded (INSTALL_TIMEOUT_MS). How npm is started without a shell: `npmCommand`.
//
// A record that exists but is unreadable or not a strict x.y.z is a loud failure naming the file, never read as "no
// record".
//
// The registry base URL is the public default; `DASHBOARD_MCP_REGISTRY_BASE_URL` overrides it and exists only as the
// tests' seam (like `DASHBOARD_MCP_REGISTRY_TIMEOUT_MS`).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DASHBOARD_MCP_PACKAGE_NAME = "@thehammer/danx-dashboard-mcp";

export const DEFAULT_REGISTRY_BASE_URL = "https://registry.npmjs.org";
export const REGISTRY_BASE_URL_ENV = "DASHBOARD_MCP_REGISTRY_BASE_URL";
export const REGISTRY_TIMEOUT_ENV = "DASHBOARD_MCP_REGISTRY_TIMEOUT_MS";
/** Bounds the one registry request. */
export const REGISTRY_TIMEOUT_MS = 5_000;
/** DX-3811: an unreachable registry cannot wedge an install for longer than this. */
export const INSTALL_TIMEOUT_MS = 60_000;
/** A staging directory or an unused version directory older than this is removed (a younger stage is a concurrent install's). */
export const STALE_INSTALL_MS = 60 * 60 * 1000;
const STAGE_PREFIX = ".stage-";

/** Windows refuses a rename for a moment while another process (a reader, a virus scanner) has the file open: retry it. */
const RENAME_RETRY_ATTEMPTS = 8;
const RENAME_RETRY_BASE_MS = 25;
const RENAME_RETRYABLE_CODES = ["EPERM", "EBUSY", "EACCES"];

const STRICT_VERSION = /^\d+\.\d+\.\d+$/;
/** How much of a damaged record's content its error quotes. */
const DAMAGED_RECORD_EXCERPT_CHARS = 40;

/** Any message as one line: every failure here is reported in exactly one. */
export const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

/** `<registry>/<name>/latest`, the name's slash encoded the way the registry's own tooling writes it. */
export function registryUrl(env = process.env) {
  const base = (env[REGISTRY_BASE_URL_ENV] || DEFAULT_REGISTRY_BASE_URL).replace(/\/+$/, "");
  return `${base}/${DASHBOARD_MCP_PACKAGE_NAME.replace("/", "%2F")}/latest`;
}

const specOf = (version) => `${DASHBOARD_MCP_PACKAGE_NAME}@${version}`;

/**
 * The registry's current `latest` version, a strict `x.y.z`. Throws an Error naming the URL and the
 * reason on a network error, a timeout, a non-200 or a body that is not one.
 */
export async function resolveLatestVersion({ env = process.env, fetchFn = fetch, timeoutMs } = {}) {
  const url = registryUrl(env);
  const bound = timeoutMs ?? (Number(env[REGISTRY_TIMEOUT_ENV]) > 0 ? Number(env[REGISTRY_TIMEOUT_ENV]) : REGISTRY_TIMEOUT_MS);
  const fail = (reason) => new Error(`could not read ${url}: ${reason}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bound);
  let response;
  let text;
  try {
    response = await fetchFn(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (response.status === 200) text = await response.text();
  } catch (err) {
    throw fail(controller.signal.aborted ? `no answer within ${bound}ms` : `network error (${err.cause?.code ?? err.message})`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) throw fail(`HTTP ${response.status}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw fail("the answer is not valid JSON");
  }
  const version = body?.version;
  if (typeof version !== "string" || !STRICT_VERSION.test(version)) {
    throw fail(`the answer is not a strict x.y.z version (${JSON.stringify(version ?? null)})`);
  }
  return version;
}

function dataDirOf(env) {
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error("CLAUDE_PLUGIN_DATA is not set: this only runs as part of the danxbot plugin");
  return env.CLAUDE_PLUGIN_DATA;
}

/** `${CLAUDE_PLUGIN_DATA}/dashboard-mcp`: the record, the per-version install directories and the staging directories. */
const installRoot = (dataDir) => path.join(dataDir, "dashboard-mcp");

/** `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current` — beside the per-version install directories. */
export function recordFile(env = process.env) {
  return path.join(installRoot(dataDirOf(env)), "current");
}

const BIN_REL = ["node_modules", ...DASHBOARD_MCP_PACKAGE_NAME.split("/"), "dist", "index.js"];
const versionDir = (dataDir, version) => path.join(installRoot(dataDir), version);

/** A version's installed entry point under the plugin data directory: the one layout `installVersion` lays down. */
export function installedBin(dataDir, version) {
  return path.join(versionDir(dataDir, version), ...BIN_REL);
}

/**
 * The recorded version; `null` ONLY when no record exists. A record that cannot be read or holds
 * something that is not a strict x.y.z throws, naming the file and the fix. No network.
 */
export function recordedVersionOrNull(env = process.env) {
  const file = recordFile(env);
  const fix = `delete ${file} so the next start records a fresh version`;
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`the recorded ${DASHBOARD_MCP_PACKAGE_NAME} version in ${file} cannot be read (${err.code ?? err.message}); ${fix}`);
  }
  if (!STRICT_VERSION.test(text)) {
    throw new Error(
      `the recorded ${DASHBOARD_MCP_PACKAGE_NAME} version in ${file} is damaged (${JSON.stringify(text.slice(0, DAMAGED_RECORD_EXCERPT_CHARS))} is not x.y.z); ${fix}`,
    );
  }
  return text;
}

/** The recorded version; throws, with the line saying nothing can run, when none is recorded. Sync, no network. */
export function requireRecordedVersion(env = process.env) {
  const version = recordedVersionOrNull(env);
  if (version === null) throw new Error(noVersionLine("the dashboard MCP server has not recorded one yet"));
  return version;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `renameSync`, retried while Windows briefly refuses it. `settled()` is asked after each refusal: true means the rename
 * no longer needs to happen (a concurrent installer's copy is already in place), and the answer is false. True when renamed.
 */
function renameRetrying(from, to, fsApi, settled = () => false) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsApi.renameSync(from, to);
      return true;
    } catch (err) {
      if (settled()) return false;
      if (attempt >= RENAME_RETRY_ATTEMPTS || !RENAME_RETRYABLE_CODES.includes(err.code)) throw err;
      sleepSync(RENAME_RETRY_BASE_MS * attempt);
    }
  }
}

/**
 * Temp file + rename: a reader sees the old record or the new one, never a partial. Concurrent
 * writers each use their own temp name. `fsApi` is the filesystem (a test seam for asserting the
 * mechanism).
 */
export function writeRecordedVersion(version, env = process.env, fsApi = fs) {
  const file = recordFile(env);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const fail = (err) => new Error(`could not record version ${version} in ${file} (${err.code ?? err.message}); make ${path.dirname(file)} writable`);
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    // DX-4235: before the temp file's cleanup, which on Linux throws ENOTDIR (hiding this reason) when the directory is a file.
    throw fail(err);
  }
  try {
    fsApi.writeFileSync(tmp, `${version}\n`);
    renameRetrying(tmp, file, fsApi);
  } catch (err) {
    throw fail(err);
  } finally {
    fsApi.rmSync(tmp, { force: true });
  }
}

/** The line a failed refresh prints: the reason and the version the session keeps running. */
export function keptLine(reason, version) {
  return `could not refresh the ${DASHBOARD_MCP_PACKAGE_NAME} version (${reason}); this session keeps running ${version}`;
}

/** The line when there is nothing to fall back to. */
export function noVersionLine(reason) {
  return `no ${DASHBOARD_MCP_PACKAGE_NAME} version is recorded and one could not be obtained (${reason}), so nothing that runs it can start`;
}

/**
 * How npm is started, with NO shell (DX-4235). Since Node 18.20.2 / 20.12.2 spawning a `.cmd` without `shell: true`
 * throws EINVAL, and a bare `npm` is not found at all (Windows' npm is `npm.cmd`; no PATHEXT lookup without a shell), so
 * on Windows the node running this runs npm's own `npm-cli.js`, which every Windows node install (the official installer,
 * nvm-windows, a zip) keeps beside `node.exe` at `node_modules/npm/bin/npm-cli.js`. Elsewhere `npm` on PATH is an
 * executable (a link to that same `npm-cli.js`, or a distribution's script) that the OS starts directly.
 * Throws, naming the path, when a Windows node has no npm beside it.
 */
export function npmCommand(platform = process.platform, execPath = process.execPath, exists = fs.existsSync) {
  if (platform !== "win32") return { command: "npm", args: [] };
  const cli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!exists(cli)) throw new Error(`npm_not_found: the node running this (${execPath}) has no npm beside it at ${cli}`);
  return { command: execPath, args: [cli] };
}

/**
 * `npm <args>`, its output captured (never inherited: the launcher's stdout is the MCP stream). Resolves
 * `{code, signal, output}`; rejects with one line when npm cannot be started or outlives `timeoutMs` (it is killed).
 */
function runNpm(npm, args, { env, spawnFn, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const child = spawnFn(npm.command, [...npm.args, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill();
      settle(reject, new Error(`timeout: ${label} took longer than ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", (err) => settle(reject, new Error(`npm_not_started: could not start npm (${npm.command}) for ${label}: ${err.message}`)));
    child.on("close", (code, signal) => settle(resolve, { code, signal, output }));
  });
}

/**
 * Installs `version` into its own directory under the plugin data dir (when it is not installed already) and returns its
 * entry point. Throws ONE line naming why on a timeout, an npm failure, an install that left no entry point, or a rename
 * that failed for any reason but a concurrent install having won.
 * Seams: `spawnFn` (npm's process), `npm` (from `npmCommand`), `installTimeoutMs`.
 */
export async function installVersion(version, { env = process.env, spawnFn = spawn, npm, installTimeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  const dataDir = dataDirOf(env);
  const bin = installedBin(dataDir, version);
  if (fs.existsSync(bin)) return bin;
  const spec = specOf(version);
  const root = installRoot(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, STAGE_PREFIX));
  try {
    const result = await runNpm(
      npm ?? npmCommand(),
      ["install", "--prefix", stage, "--no-audit", "--no-fund", "--no-save", "--loglevel=error", spec],
      { env, spawnFn, timeoutMs: installTimeoutMs, label: `installing ${spec}` },
    );
    if (result.code !== 0) {
      const last = result.output.split(/\r?\n/).filter((line) => line.trim()).at(-1) ?? "no output";
      throw new Error(`install_failed: npm install ${spec} exited ${result.code ?? result.signal}: ${oneLine(last)}`);
    }
    if (!fs.existsSync(path.join(stage, ...BIN_REL))) {
      throw new Error(`install_incomplete: npm install ${spec} succeeded but left no ${BIN_REL.join("/")}`);
    }
    try {
      // DX-3811: the rename refuses a destination that already holds an install (where `mv` would nest the stage inside
      // it), so the loser of a concurrent install keeps the winner's; ours is removed below.
      renameRetrying(stage, versionDir(dataDir, version), fs, () => fs.existsSync(bin));
    } catch (err) {
      throw new Error(`install_incomplete: could not move the verified install of ${spec} into place (${err.code ?? err.message})`);
    }
    return bin;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Removes, under the plugin data dir, every staging directory and every version directory not named in `keep` that is
 * older than STALE_INSTALL_MS at `now` (DX-4321). A younger stage is a concurrent install's; a younger version directory may
 * be another session's server. The record and anything not shaped like a version or a stage are never touched.
 */
export function pruneInstalls(keep, { env = process.env, now = Date.now() } = {}) {
  const root = installRoot(dataDirOf(env));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const isStage = entry.name.startsWith(STAGE_PREFIX);
    if (!isStage && (!STRICT_VERSION.test(entry.name) || keep.includes(entry.name))) continue;
    const dir = path.join(root, entry.name);
    if (now - fs.statSync(dir).mtimeMs > STALE_INSTALL_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The version the launcher starts the server from, installed: the recorded one, with no registry request; with none
 * recorded, the registry's `latest`, installed and then recorded. Returns `{version, bin}`. Throws one line when nothing
 * can start (no record and no registry answer, or a failed install).
 */
export async function startVersion(options = {}) {
  const env = options.env ?? process.env;
  const recorded = recordedVersionOrNull(env);
  if (recorded !== null) return { version: recorded, bin: await installVersion(recorded, options) };
  let version;
  try {
    version = await resolveLatestVersion(options);
  } catch (err) {
    throw new Error(noVersionLine(oneLine(err.message)));
  }
  const bin = await installVersion(version, options);
  writeRecordedVersion(version, env);
  return { version, bin };
}

/**
 * The refresh that runs while the server does: the registry's `latest` is installed, THEN recorded (DX-4235: the record
 * only ever names an installed version, so the next start never pays a cold install), then old installs are pruned
 * (never `running` or the new version). Returns the version recorded. The running server is never touched: a new version
 * is adopted at the next session start. Throws (the caller reports one line and keeps `running`).
 */
export async function refreshInstall(running, options = {}) {
  const env = options.env ?? process.env;
  const latest = await resolveLatestVersion(options);
  await installVersion(latest, options);
  writeRecordedVersion(latest, env);
  pruneInstalls([running, latest], { env, now: options.now ?? Date.now() });
  return latest;
}
