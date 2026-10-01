// Fakes for the two things event-hook.sh / ensure-dashboard-mcp.sh run (DX-3811):
// the installed `@thehammer/danx-dashboard-mcp` bin, and the `npm` / `npx` on PATH.
// No test using these touches the network.
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DASHBOARD_MCP_PACKAGE } from "../../scripts/lib/dashboard-mcp-package.mjs";

export const PKG_NAME = DASHBOARD_MCP_PACKAGE.slice(0, DASHBOARD_MCP_PACKAGE.lastIndexOf("@"));
export const PKG_VERSION = DASHBOARD_MCP_PACKAGE.slice(DASHBOARD_MCP_PACKAGE.lastIndexOf("@") + 1);

/** Where ensure-dashboard-mcp.sh puts the pinned package's entry point under `dataDir`. */
export function installedBinPath(dataDir) {
  return path.join(dataDir, "dashboard-mcp", PKG_VERSION, "node_modules", PKG_NAME, "dist", "index.js");
}

/**
 * The fake bin's behaviour, from `$FAKE_MCP_MODE`:
 *   success     -> prints $FAKE_MCP_TEXT, exit 0
 *   empty       -> prints nothing, exit 0
 *   fail        -> prints $FAKE_MCP_STDERR to stderr, exit 1
 *   silent-fail -> exit 3 with no output at all
 *   hang        -> never returns (the caller's timeout must end it)
 * It records the args it was called with into $FAKE_MCP_ARGS_FILE.
 */
export const FAKE_BIN_SOURCE = `
const fs = require("node:fs");
if (process.env.FAKE_MCP_ARGS_FILE) fs.writeFileSync(process.env.FAKE_MCP_ARGS_FILE, process.argv.slice(2).join(" ") + "\\n");
switch (process.env.FAKE_MCP_MODE || "fail") {
  case "success": process.stdout.write(process.env.FAKE_MCP_TEXT || ""); break;
  case "empty": break;
  case "silent-fail": process.exit(3); break;
  case "hang": setInterval(() => {}, 1000); break;
  default: process.stderr.write((process.env.FAKE_MCP_STDERR || "fake mcp: forced failure") + "\\n"); process.exit(1);
}
`;

/** A file holding the fake bin source, for the fake `npm` to copy into a staged install. */
export function writeFakeBinSourceFile() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fake-bin-src-")), "index.js");
  writeFileSync(file, FAKE_BIN_SOURCE);
  return file;
}

/** Puts the fake bin where an installed pin lives under `dataDir`. */
export function installFakeMcp(dataDir) {
  const bin = installedBinPath(dataDir);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, FAKE_BIN_SOURCE);
  return bin;
}

/** A directory holding one executable bash script per `{name: body}`; put it FIRST on PATH. */
export function makeFakeBinDir(scripts) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-bin-"));
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** `npx` that records being called, then fails: the hook must never reach it. */
export const NPX_TRIPWIRE = 'echo "npx was called: $*" >> "$FAKE_NPX_CALLS_FILE"; exit 99';

/**
 * `npm` standing in for `npm install --prefix <dir> ... <spec>`: records the call, then
 * `$FAKE_NPM_MODE` decides:
 *   ok     lays down the fake bin under <dir>
 *   slow   does so after 2 s (a cold install longer than the fetch budget)
 *   race   does so while ANOTHER caller completes the final install, so the rename loses
 *   no-bin exits 0 leaving nothing
 *   hang   never returns
 *   other  prints a registry error and exits 1
 */
export const fakeNpm = () => `
echo "$*" >> "$FAKE_NPM_CALLS_FILE"
PREFIX=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then PREFIX="$2"; shift; fi
  shift
done
lay_down() {
  mkdir -p "$1/node_modules/${PKG_NAME}/dist"
  cp "$FAKE_BIN_SOURCE_FILE" "$1/node_modules/${PKG_NAME}/dist/index.js"
}
case "\${FAKE_NPM_MODE:-ok}" in
  ok) lay_down "$PREFIX" ;;
  slow) sleep 2; lay_down "$PREFIX" ;;
  race) lay_down "$(dirname "$PREFIX")/${PKG_VERSION}"; lay_down "$PREFIX" ;;
  no-bin) ;;
  hang) exec sleep 30 ;;
  *) echo "npm error code E404" >&2; echo "npm error 404 Not Found - registry unreachable" >&2; exit 1 ;;
esac
`;
