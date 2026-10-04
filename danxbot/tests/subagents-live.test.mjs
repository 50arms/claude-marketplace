// DX-4508 — scripts/subagents-live.mjs: the plan pane's live sub-agent reader. The hooks module starts it with node; it finds the
// plugin's data directory from its own location, reads the recorded danx-dashboard-mcp version and runs that installed version's
// `subagents-live` in its own process. A stand-in package (a temp marketplace layout) stands in for the installed one.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_SUBCOMMAND, installedBin, isAlive, pluginDataDir, resolveLiveBin, watchParent } from "../scripts/subagents-live.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

describe("where the installed reader is", () => {
  test("a marketplace install's data directory, by Claude Code's layout", () => {
    const root = path.join(tmpdir(), "plugins", "cache", "newms-plugins", "danxbot", "0.12.35");
    assert.deepEqual(pluginDataDir(root), { dir: path.join(tmpdir(), "plugins", "data", "danxbot-newms-plugins") });
    // a trailing separator is the same root
    assert.deepEqual(pluginDataDir(`${root}${path.sep}`), pluginDataDir(root));
  });

  test("a root of any other shape (a --plugin-dir load) is a named reason, never a guess", () => {
    const r = pluginDataDir(path.join(tmpdir(), "work", "claude-plugins", "danxbot"));
    assert.match(r.reason, /not loaded from a marketplace install/);
  });

  test("the bin is the layout ensure-dashboard-mcp.sh installs", () => {
    const sh = readFileSync(path.join(SCRIPTS, "ensure-dashboard-mcp.sh"), "utf8");
    assert.match(sh, /^BIN_REL="node_modules\/\$\{PKG_NAME\}\/dist\/index\.js"$/m);
    assert.equal(installedBin("D", "1.2.3"), path.join("D", "dashboard-mcp", "1.2.3", "node_modules", "@thehammer", "danx-dashboard-mcp", "dist", "index.js"));
  });
});

/** A marketplace-shaped plugin install with this script and its lib, and its data directory. */
function install(base) {
  const root = path.join(base, "plugins", "cache", "mkt", "danxbot", "1.0.0");
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  copyFileSync(path.join(SCRIPTS, "subagents-live.mjs"), path.join(root, "scripts", "subagents-live.mjs"));
  copyFileSync(path.join(SCRIPTS, "lib", "dashboard-mcp-package.mjs"), path.join(root, "scripts", "lib", "dashboard-mcp-package.mjs"));
  const data = path.join(base, "plugins", "data", "danxbot-mkt");
  return { root, data, script: path.join(root, "scripts", "subagents-live.mjs") };
}

function record(data, text) {
  mkdirSync(path.join(data, "dashboard-mcp"), { recursive: true });
  writeFileSync(path.join(data, "dashboard-mcp", "current"), text);
}

// The stand-in package entry point: prints the argv it was run with, as the real one would read it.
const FAKE_BIN = `process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n");\n`;

describe("resolving and running the recorded version", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "subagents-live-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test("no recorded version: the reason, nothing run", () => {
    const { root } = install(base);
    const r = resolveLiveBin(root);
    assert.equal(r.ok, false);
    assert.match(r.reason, /no @thehammer\/danx-dashboard-mcp version is recorded/);
  });

  test("a damaged record: its own reason", () => {
    const { root, data } = install(base);
    record(data, "latest\n");
    assert.match(resolveLiveBin(root).reason, /is damaged/);
  });

  test("a recorded version that is not installed: the reason names where it was looked for", () => {
    const { root, data } = install(base);
    record(data, "0.1.5\n");
    const r = resolveLiveBin(root);
    assert.equal(r.reason, `@thehammer/danx-dashboard-mcp 0.1.5 is not installed at ${installedBin(data, "0.1.5")}`);
  });

  test("the script runs the installed entry point in its own process, as `node <bin> subagents-live <transcript>`", () => {
    const { script, data } = install(base);
    record(data, "0.1.5\n");
    const bin = installedBin(data, "0.1.5");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, FAKE_BIN);
    const transcript = path.join(base, "sess.jsonl");
    const r = spawnSync(process.execPath, [script, transcript], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [bin, LIVE_SUBCOMMAND, transcript]);
  });

  test("a failure to start is one stderr line and exit 1", () => {
    const { script } = install(base);
    const r = spawnSync(process.execPath, [script, path.join(base, "sess.jsonl")], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.match(r.stderr, /no @thehammer\/danx-dashboard-mcp version is recorded/);
  });
});

describe("the starting process", () => {
  test("a process that exists is alive, also when it may not be signalled; one that does not is gone", () => {
    assert.equal(isAlive(1, () => true), true);
    assert.equal(isAlive(1, () => { throw Object.assign(new Error("perm"), { code: "EPERM" }); }), true);
    assert.equal(isAlive(1, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }), false);
    assert.equal(isAlive(process.pid), true);
  });

  test("the watch fires once the parent is gone, checking on its interval, and never holds the process open", () => {
    let tick;
    let interval;
    let unref = false;
    let alive = true;
    let gone = 0;
    watchParent(42, () => gone++, {
      intervalMs: 5,
      kill: () => {
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      setIntervalFn: (fn, ms) => {
        tick = fn;
        interval = ms;
        return { unref: () => (unref = true) };
      },
    });
    assert.equal(interval, 5);
    assert.equal(unref, true);
    tick();
    assert.equal(gone, 0);
    alive = false;
    tick();
    assert.equal(gone, 1);
  });
});
