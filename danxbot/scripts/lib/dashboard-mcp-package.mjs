#!/usr/bin/env node
// The ONE place that says which version of `@thehammer/danx-dashboard-mcp` every run of it
// this plugin makes uses (DX-4321): the plan event bridge, background-work-report,
// activity-report and event-hook.sh. This file carries NO version literal.
//
// WHERE THE VERSION COMES FROM. The npm registry's `latest` for the package, read at every
// session start (`versionFor({sessionStart: true})`) and recorded in
// `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current` (temp file + rename, so a reader never sees a
// partial one). Every other hook reads that record and makes no registry request
// (`versionFor({sessionStart: false})`); one that finds none resolves it through the same path.
// A danxbot publish therefore reaches the next session start with no plugin release.
//
// WHY EXACT, NOT `latest` AT RUN TIME (DX-3392): `npx -y` never re-checks the registry once a
// version is cached, so an unpinned spec would keep serving whatever this machine cached
// first. The plugin still runs an exact version; it reads which one instead of having it
// typed in. ensure-dashboard-mcp.sh installs exactly that version into the plugin data dir,
// one directory per version.
//
// A REFRESH THAT FAILS keeps the recorded version running (whether a version is too old is
// the server's decision, `mcp_outdated`) and says so in ONE line naming the reason and the
// version still in use. With no record there is nothing to run and the line says that. A
// record that exists but is unreadable or not a strict x.y.z is a loud failure naming the file
// (the next successful session-start refresh replaces it), never read as "no record".
//
// ONE ACCEPTED SILENT PATH (DX-3421, by design): an UNCONNECTED session whose refresh fails
// prints nothing at session start (event-hook.sh stays silent for it unless it has a restart
// notice, and the bridge and background-work-report only act for a plan-connected session). If
// that session later runs `plan_connect`, the bridge reads the record with no network and
// says nothing about the earlier failed refresh. An unconnected session is told nothing by
// danxbot at all, and no marker is kept to say otherwise.
//
// The registry base URL is the public default; `DASHBOARD_MCP_REGISTRY_BASE_URL` overrides it
// and exists only as the tests' seam (like `DASHBOARD_MCP_REGISTRY_TIMEOUT_MS`).
//
// CLI (for bash):
//   (no args)    print the recorded spec `<name>@<version>` with no newline; resolve first if none
//   --refresh    resolve and record, then print the spec. Exit 0 refreshed; exit
//                EXIT_REFRESH_FAILED_KEPT (3) the refresh failed, the RECORDED spec is on stdout
//                and the one line on stderr; exit 1 nothing recorded and none obtainable
//                (nothing on stdout, the line on stderr)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_MCP_PACKAGE_NAME = "@thehammer/danx-dashboard-mcp";

export const DEFAULT_REGISTRY_BASE_URL = "https://registry.npmjs.org";
export const REGISTRY_BASE_URL_ENV = "DASHBOARD_MCP_REGISTRY_BASE_URL";
export const REGISTRY_TIMEOUT_ENV = "DASHBOARD_MCP_REGISTRY_TIMEOUT_MS";
/** A session start must not wait on npm: bounds the one registry request. */
export const REGISTRY_TIMEOUT_MS = 5_000;
/** `--refresh` exits with this when the refresh failed but a recorded version carries on (event-hook.sh reads it). */
export const EXIT_REFRESH_FAILED_KEPT = 3;

/** Windows refuses to replace a file another process has open for a moment: retry the record's rename. */
export const RENAME_RETRY_ATTEMPTS = 8;
export const RENAME_RETRY_BASE_MS = 25;
export const RENAME_RETRYABLE_CODES = ["EPERM", "EBUSY", "EACCES"];

const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

/** A write of the record failed; its own reason, not a registry failure. */
export class RecordWriteError extends Error {}

/** `<registry>/<name>/latest`, the name's slash encoded the way the registry's own tooling writes it. */
export function registryUrl(env = process.env) {
  const base = (env[REGISTRY_BASE_URL_ENV] || DEFAULT_REGISTRY_BASE_URL).replace(/\/+$/, "");
  return `${base}/${DASHBOARD_MCP_PACKAGE_NAME.replace("/", "%2F")}/latest`;
}

export const specOf = (version) => `${DASHBOARD_MCP_PACKAGE_NAME}@${version}`;

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

/** `${CLAUDE_PLUGIN_DATA}/dashboard-mcp/current` — beside the per-version install directories. */
export function recordFile(env = process.env) {
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error("CLAUDE_PLUGIN_DATA is not set — this only runs from the danxbot plugin's hooks");
  return path.join(env.CLAUDE_PLUGIN_DATA, "dashboard-mcp", "current");
}

/**
 * The recorded version; `null` ONLY when no record exists. A record that cannot be read or holds
 * something that is not a strict x.y.z throws, naming the file. No network.
 */
export function recordedVersionOrNull(env = process.env) {
  const file = recordFile(env);
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`the recorded ${DASHBOARD_MCP_PACKAGE_NAME} version in ${file} cannot be read (${err.code ?? err.message})`);
  }
  if (!STRICT_VERSION.test(text)) {
    throw new Error(`the recorded ${DASHBOARD_MCP_PACKAGE_NAME} version in ${file} is damaged (${JSON.stringify(text.slice(0, 40))} is not x.y.z)`);
  }
  return text;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Temp file + rename: a reader sees the old record or the new one, never a partial. Concurrent
 * writers each use their own temp name. `fsApi` is the filesystem (a test seam for asserting the
 * mechanism).
 */
export function writeRecordedVersion(version, env = process.env, fsApi = fs) {
  const file = recordFile(env);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    fsApi.writeFileSync(tmp, `${version}\n`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        fsApi.renameSync(tmp, file);
        return;
      } catch (err) {
        if (attempt >= RENAME_RETRY_ATTEMPTS || !RENAME_RETRYABLE_CODES.includes(err.code)) throw err;
        sleepSync(RENAME_RETRY_BASE_MS * attempt);
      }
    }
  } catch (err) {
    throw new RecordWriteError(`could not record version ${version} in ${file} (${err.code ?? err.message})`);
  } finally {
    fsApi.rmSync(tmp, { force: true });
  }
}

/** Resolve the registry's `latest` and record it; returns the version. Throws what `resolveLatestVersion` throws, or a RecordWriteError. */
export async function refreshAndRecordVersion(options = {}) {
  const version = await resolveLatestVersion(options);
  writeRecordedVersion(version, options.env ?? process.env);
  return version;
}

/** The line a failed refresh prints: the reason and the version the session keeps running. */
export function keptLine(reason, version) {
  return `could not refresh the ${DASHBOARD_MCP_PACKAGE_NAME} version (${reason}); this session keeps running ${version}`;
}

/** The line when there is nothing to fall back to. */
export function noVersionLine(reason) {
  return `no ${DASHBOARD_MCP_PACKAGE_NAME} version is recorded and one could not be obtained (${reason}), so nothing that runs it can start`;
}

const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

/**
 * The session-start refresh. `{version, refreshed: true}` on success; on failure with a recorded
 * version `{version, refreshed: false, line}` (it keeps running, the line says why); on failure with
 * none it throws an Error whose message is the line.
 */
export async function refreshOrKeep(options = {}) {
  const env = options.env ?? process.env;
  try {
    return { version: await refreshAndRecordVersion(options), refreshed: true };
  } catch (err) {
    const recorded = recordedVersionOrNull(env);
    if (recorded === null) throw new Error(noVersionLine(oneLine(err.message)));
    return { version: recorded, refreshed: false, line: keptLine(oneLine(err.message), recorded) };
  }
}

/** The recorded version; with none, resolved and recorded (what a non-session-start hook does). A failed WRITE is reported as one, not as a registry failure. */
export async function recordedOrResolvedVersion(options = {}) {
  const env = options.env ?? process.env;
  const recorded = recordedVersionOrNull(env);
  if (recorded !== null) return recorded;
  let version;
  try {
    version = await resolveLatestVersion(options);
  } catch (err) {
    throw new Error(noVersionLine(oneLine(err.message)));
  }
  writeRecordedVersion(version, env);
  return version;
}

/**
 * THE rule every consumer applies (DX-4321): which version to run now. A session start refreshes
 * it from the registry; any other hook reads the record (resolving only when none exists).
 * Returns `{version, keptLine}`: `keptLine` is the one line a failed refresh leaves (the recorded
 * version keeps running) or `null`. Throws, with the one line saying nothing can run, when there
 * is no version at all.
 */
export async function versionFor({ sessionStart = false, env = process.env, ...options } = {}) {
  if (sessionStart) {
    const outcome = await refreshOrKeep({ env, ...options });
    return { version: outcome.version, keptLine: outcome.refreshed ? null : outcome.line };
  }
  return { version: await recordedOrResolvedVersion({ env, ...options }), keptLine: null };
}

/** `<name>@<version>` for the recorded version; throws when none is recorded. Sync, no network: for the code that builds a command. */
export function requireRecordedSpec(env = process.env) {
  const version = recordedVersionOrNull(env);
  if (version === null) throw new Error(noVersionLine("no session start has recorded one yet"));
  return specOf(version);
}

async function main(args) {
  const usage = "usage: dashboard-mcp-package.mjs [--refresh]\n";
  if (args.length > 1 || (args.length === 1 && args[0] !== "--refresh")) {
    process.stderr.write(usage);
    return 2;
  }
  try {
    if (args[0] === "--refresh") {
      const outcome = await versionFor({ sessionStart: true });
      process.stdout.write(specOf(outcome.version));
      if (outcome.keptLine === null) return 0;
      process.stderr.write(`${outcome.keptLine}\n`);
      return EXIT_REFRESH_FAILED_KEPT;
    }
    process.stdout.write(specOf((await versionFor({ sessionStart: false })).version));
    return 0;
  } catch (err) {
    process.stderr.write(`${oneLine(err.message)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
