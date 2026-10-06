// DX-3997 — the plugin integrity launcher (scripts/launch.mjs).
//
// Every case builds a throwaway plugin dir holding a small synthetic plugin plus the REAL
// launcher, damages a file the way the 2026-10-01 crash did (a file that kept its
// size and became NUL bytes), and runs the launcher as a real process. No test sleeps: the
// warning dedupe window is exercised by backdating the marker's mtime.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as generator from "../../scripts/write-integrity-manifest.mjs";
import { CORRUPT_INSTALL_FIX } from "../scripts/bridge-watchdog.mjs";

const { buildManifest, MANIFEST_FILE, listPluginFiles } = generator;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLUGIN = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(REAL_PLUGIN, "..");
const REAL_LAUNCHER = path.join(REAL_PLUGIN, "scripts", "launch.mjs");
const launcher = await import(pathToFileURL(REAL_LAUNCHER).href);
const { verifyManifest, WARN_INTERVAL_MS, claimWarning, INTEGRITY_FIX } = launcher;

const temps = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const ECHO_MJS = `import fs from "node:fs";
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));
process.exit(Number(process.env.ECHO_EXIT ?? 0));
`;
const HELLO_SH = `#!/usr/bin/env bash
printf 'hello %s stdin=%s' "$1" "$(cat)"
exit "\${ECHO_EXIT:-0}"
`;
const DEP_MJS = "export const dep = 1;\n";

const PLUGIN_FILES = {
  "scripts/echo.mjs": ECHO_MJS,
  "scripts/hello.sh": HELLO_SH,
  "scripts/other.mjs": "export const other = 1;\n",
  "scripts/lib/dep.mjs": DEP_MJS,
  "hooks/hooks.json": '{"hooks":{}}\n',
  ".claude-plugin/plugin.json": '{"name":"fake","version":"1.0.0"}\n',
};

/** A fake installed plugin: `cache/mkt/fake/1.0.0` (what hooks run from) holding the synthetic plugin plus the real launcher. */
function makeInstall() {
  const plugins = tmpDir("danxbot-launch-");
  const cache = path.join(plugins, "cache", "mkt", "fake", "1.0.0");
  for (const [rel, text] of Object.entries(PLUGIN_FILES)) {
    fs.mkdirSync(path.dirname(path.join(cache, rel)), { recursive: true });
    fs.writeFileSync(path.join(cache, rel), text);
  }
  fs.copyFileSync(REAL_LAUNCHER, path.join(cache, "scripts", "launch.mjs"));
  const files = [...Object.keys(PLUGIN_FILES), "scripts/launch.mjs"];
  fs.writeFileSync(path.join(cache, MANIFEST_FILE), `${JSON.stringify(buildManifest(cache, files), null, 2)}\n`);
  return { plugins, cache, launcher: path.join(cache, "scripts", "launch.mjs"), stateDir: tmpDir("danxbot-launch-state-") };
}

function zero(file) {
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));
}

function run(install, argv, { stdin = "", env = {} } = {}) {
  const res = spawnSync(process.execPath, [install.launcher, ...argv], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: install.stateDir, TEMP: install.stateDir, TMP: install.stateDir, CLAUDE_CODE_SESSION_ID: "", ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("a healthy install", () => {
  test("runs the .mjs script with its args and the hook's stdin, and passes the exit code through", () => {
    const install = makeInstall();
    const res = run(install, ["scripts/echo.mjs", "start", "x"], { stdin: '{"session_id":"s"}', env: { ECHO_EXIT: "7" } });
    assert.equal(res.code, 7);
    assert.deepEqual(JSON.parse(res.stdout), { args: ["start", "x"], stdin: '{"session_id":"s"}' });
    assert.equal(res.stderr, "");
  });

  test("runs a .sh script under bash", () => {
    const install = makeInstall();
    const res = run(install, ["scripts/hello.sh", "world"], { stdin: "in" });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "hello world stdin=in");
  });

  test("a script that is not in the manifest is refused loudly, never run", () => {
    const install = makeInstall();
    fs.writeFileSync(path.join(install.cache, "scripts", "stray.mjs"), "console.log('ran')\n");
    const res = run(install, ["scripts/stray.mjs"]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /not in the integrity manifest/);
  });

  test("a script outside the plugin dir is refused", () => {
    const install = makeInstall();
    const res = run(install, ["../../escape.mjs"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /outside the plugin/);
  });
});

describe("damage is detected, reported loudly and once, and the hook does not run corrupt code", () => {
  for (const [label, damage] of [
    ["zeroed (the crash shape: same size, all NUL)", (f) => zero(f)],
    ["truncated", (f) => fs.writeFileSync(f, "partial")],
    ["missing", (f) => fs.rmSync(f)],
  ]) {
    test(`verifyManifest reports a ${label} file as corrupt and leaves it as it was`, () => {
      const install = makeInstall();
      const file = path.join(install.cache, "scripts", "other.mjs");
      damage(file);
      const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const res = verifyManifest({ root: install.cache });
      assert.equal(res.manifestOk, true);
      assert.deepEqual(res.corrupt, ["scripts/other.mjs"]);
      assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, before, "nothing is rewritten");
    });
  }

  test("a healthy tree reports nothing corrupt", () => {
    const install = makeInstall();
    assert.deepEqual(verifyManifest({ root: install.cache }).corrupt, []);
  });

  test("a corrupt file is reported, with the reinstall instruction; an unaffected script still runs", () => {
    const install = makeInstall();
    zero(path.join(install.cache, "scripts", "other.mjs"));
    const res = run(install, ["--via", "stdout", "scripts/hello.sh", "w"], { stdin: "i" });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^\[danxbot plugin\] INTEGRITY FAILURE: 1 plugin file\(s\) are corrupt \(scripts\/other\.mjs\)/);
    assert.ok(res.stdout.includes(INTEGRITY_FIX));
    assert.ok(res.stdout.endsWith("hello w stdin=i"), "the hook's own output follows the warning");
    assert.match(res.stderr, /INTEGRITY FAILURE/);
  });

  test("the hook's own script is corrupt: the carrier warns and exits 0 without running anything", () => {
    const install = makeInstall();
    zero(path.join(install.cache, "scripts", "echo.mjs"));
    const res = run(install, ["--via", "stdout", "scripts/echo.mjs"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /INTEGRITY FAILURE: .*scripts\/echo\.mjs/);
    assert.equal(res.stdout.includes('"args"'), false, "the corrupt script was not run");
  });

  test("a corrupt .sh target is not run either", () => {
    const install = makeInstall();
    zero(path.join(install.cache, "scripts", "hello.sh"));
    const res = run(install, ["scripts/hello.sh", "w"]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /INTEGRITY FAILURE: .*scripts\/hello\.sh/);
  });

  test("a rewake hook whose script is corrupt exits 2 with the warning on stderr, which wakes the session", () => {
    const install = makeInstall();
    zero(path.join(install.cache, "scripts", "echo.mjs"));
    const res = run(install, ["--via", "rewake", "scripts/echo.mjs"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /INTEGRITY FAILURE: .*scripts\/echo\.mjs/);
    assert.equal(res.stdout, "");
  });

  test("a hook with no model-visible channel reports on stderr and exits 1", () => {
    const install = makeInstall();
    zero(path.join(install.cache, "scripts", "echo.mjs"));
    const res = run(install, ["scripts/echo.mjs"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /INTEGRITY FAILURE/);
    assert.equal(res.stdout, "");
  });

  test("the warning appears once per window: a second run inside it is silent on stdout, and after the window it returns", () => {
    const install = makeInstall();
    zero(path.join(install.cache, "scripts", "other.mjs"));
    const first = run(install, ["--via", "stdout", "scripts/hello.sh", "a"]);
    assert.match(first.stdout, /INTEGRITY FAILURE/);
    const second = run(install, ["--via", "stdout", "scripts/hello.sh", "a"]);
    assert.equal(second.stdout, "hello a stdin=");
    const marker = fs.readdirSync(install.stateDir).find((n) => n.startsWith("danxbot-integrity-"));
    assert.ok(marker, "a dedupe marker exists in the temp dir");
    const past = new Date(Date.now() - WARN_INTERVAL_MS - 60_000);
    fs.utimesSync(path.join(install.stateDir, marker), past, past);
    const third = run(install, ["--via", "stdout", "scripts/hello.sh", "a"]);
    assert.match(third.stdout, /INTEGRITY FAILURE/);
  });

  test("an unreadable manifest means nothing is verified: say so, and still run the hook", () => {
    const install = makeInstall();
    zero(path.join(install.cache, MANIFEST_FILE));
    const res = run(install, ["--via", "stdout", "scripts/hello.sh", "m"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /integrity manifest is unreadable/);
    assert.ok(res.stdout.endsWith("hello m stdin="));
    assert.equal(verifyManifest({ root: install.cache }).manifestOk, false);
  });
});

describe("claimWarning", () => {
  test("only the first caller in a window claims the right to warn; a different problem and an expired window each claim again", () => {
    const state = tmpDir("danxbot-claim-");
    const now = Date.now();
    assert.equal(claimWarning("sig-a", { dir: state, now }), true);
    assert.equal(claimWarning("sig-a", { dir: state, now }), false);
    assert.equal(claimWarning("sig-b", { dir: state, now }), true, "a different problem is its own warning");
    for (const name of fs.readdirSync(state)) {
      const past = new Date(now - WARN_INTERVAL_MS - 1000);
      fs.utimesSync(path.join(state, name), past, past);
    }
    assert.equal(claimWarning("sig-a", { dir: state, now }), true);
    assert.equal(claimWarning("sig-a", { dir: state, now }), false, "the claim restarts the window");
  });
});

describe("the real plugin", () => {
  function realPluginInstall() {
    const cache = path.join(tmpDir("danxbot-real-"), "cache", "mkt", "danxbot", "9.9.9");
    for (const rel of listPluginFiles(REPO_ROOT, "danxbot")) {
      fs.mkdirSync(path.dirname(path.join(cache, rel)), { recursive: true });
      fs.copyFileSync(path.join(REAL_PLUGIN, rel), path.join(cache, rel));
    }
    // the manifest the publish step would write for this tree
    fs.writeFileSync(path.join(cache, MANIFEST_FILE), `${JSON.stringify(buildManifest(cache, listPluginFiles(REPO_ROOT, "danxbot")), null, 2)}\n`);
    return { cache };
  }

  test("zeroing ANY shipped file is detected on the next verification (planted-corruption test over the whole tree)", () => {
    const { cache } = realPluginInstall();
    const files = Object.keys(JSON.parse(fs.readFileSync(path.join(cache, MANIFEST_FILE), "utf8")).files);
    assert.ok(files.includes("scripts/plan-event-bridge.mjs") && files.includes("scripts/inject-time.sh") && files.includes("scripts/launch.mjs"));
    assert.ok(files.length >= 15, `expected the whole plugin in the manifest, got ${files.length}`);
    assert.deepEqual(verifyManifest({ root: cache }).corrupt, []);
    for (const rel of files) {
      const original = fs.readFileSync(path.join(cache, rel));
      zero(path.join(cache, rel));
      assert.deepEqual(verifyManifest({ root: cache }).corrupt, [rel], `${rel} should be reported corrupt`);
      fs.writeFileSync(path.join(cache, rel), original);
    }
  });

  test("the published manifest never lists the tests or itself", () => {
    const files = listPluginFiles(REPO_ROOT, "danxbot");
    assert.equal(files.some((f) => f.startsWith("tests/") || f === MANIFEST_FILE), false);
  });

  test("every hook command in hooks.json runs through the launcher, and every script it names is hashed", () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REAL_PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
    const hashed = new Set(listPluginFiles(REPO_ROOT, "danxbot"));
    let seen = 0;
    for (const groups of Object.values(hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          seen += 1;
          const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/launch\.mjs" (?:--via (?:stdout|rewake) )?(scripts\/\S+)/.exec(hook.command);
          assert.ok(m, `hook command does not go through the launcher: ${hook.command}`);
          assert.ok(hashed.has(m[1]), `${m[1]} is not a shipped file`);
        }
      }
    }
    assert.ok(seen >= 10);
  });

  test("the committed integrity-manifest.json is current: regenerate it with node scripts/write-integrity-manifest.mjs danxbot", () => {
    const committed = JSON.parse(fs.readFileSync(path.join(REAL_PLUGIN, MANIFEST_FILE), "utf8"));
    assert.deepEqual(committed, buildManifest(REAL_PLUGIN, listPluginFiles(REPO_ROOT, "danxbot")));
  });

  test("the launcher and the generator agree on the manifest file name and schema (the launcher cannot import them)", () => {
    assert.equal(launcher.MANIFEST_FILE, generator.MANIFEST_FILE);
    assert.equal(launcher.MANIFEST_SCHEMA_VERSION, generator.MANIFEST_SCHEMA_VERSION);
  });

  test("every integrity message gives the same repair instruction: launcher, watchdog notice, and both hooks.json fallback lines", () => {
    assert.equal(INTEGRITY_FIX, `Fix: ${CORRUPT_INSTALL_FIX}.`);
    assert.equal(INTEGRITY_FIX, "Fix: run `claude plugin uninstall danxbot@50arms --keep-data`, then `claude plugin install danxbot@50arms` (add `--config dashboard_url=<address>` if you had set a custom dashboard address, which a reinstall forgets), then restart the session.");
    const hooks = JSON.parse(fs.readFileSync(path.join(REAL_PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
    const fallbacks = Object.values(hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command)
      .filter((command) => command.includes(" || echo "));
    assert.equal(fallbacks.length, 2, "the two model-visible hooks carry a fallback");
    for (const command of fallbacks) assert.ok(command.includes(INTEGRITY_FIX), `fallback lacks the repair instruction: ${command}`);
  });

  test("a zeroed launch.mjs cannot report itself, so the model-visible hook prints its own fallback line and exits 0; healthy, it prints none", () => {
    const { cache } = realPluginInstall();
    const hooks = JSON.parse(fs.readFileSync(path.join(REAL_PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
    const command = hooks.UserPromptSubmit[0].hooks[0].command;
    const runHook = () =>
      spawnSync("bash", ["-c", command], {
        input: JSON.stringify({ session_id: "launch-test-fallback" }),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: cache },
      });
    const healthy = runHook();
    assert.equal(healthy.status, 0);
    assert.equal(healthy.stdout.includes("[danxbot plugin]"), false, healthy.stdout);
    zero(path.join(cache, "scripts", "launch.mjs"));
    const damaged = runHook();
    assert.equal(damaged.status, 0);
    assert.ok(damaged.stdout.includes("[danxbot plugin] a danxbot hook failed to run"), damaged.stdout);
    assert.ok(damaged.stdout.includes(INTEGRITY_FIX));
  });
});

