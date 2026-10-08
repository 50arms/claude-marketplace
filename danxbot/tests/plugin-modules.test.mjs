// The shape of the danxbot plugin: every hook is a native function hook of one module (hooks/register.tsx), and scripts/ holds
// only the MCP server launcher, the Plan pane's live sub-agent reader and the screenshot tool. The module's own behaviour is tested
// by `claude plugin test danxbot` (tests/*.test.tsx); this file pins the manifest shape and that the engine's own validator accepts
// the plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(PLUGIN, rel), "utf8"));

/** Every file under `dir`, as `/`-separated paths relative to it, sorted. */
function filesUnder(dir) {
  const walk = (rel) =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const next = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(next) : [next];
    });
  return walk("").sort();
}

test("DX-4232 / DX-4235: hooks.json declares the module and no command hooks", () => {
  const hooks = readJson("hooks/hooks.json");
  assert.deepEqual(hooks.modules, ["./register.tsx"]);
  assert.ok(fs.existsSync(path.join(PLUGIN, "hooks", "register.tsx")));
  // DX-4235: a command hook would be a second, unvalidated hook path beside the module; every hook lives in register.tsx.
  assert.equal(Object.hasOwn(hooks, "hooks"), false, "hooks.json has a hooks key");
  assert.deepEqual(Object.keys(hooks).sort(), ["description", "modules"]);
});

test("DX-4235: scripts/ holds only the MCP server launcher, the live sub-agent reader and the screenshot tool", () => {
  assert.deepEqual(filesUnder(path.join(PLUGIN, "scripts")), [
    "capture-screenshot.mjs",
    "dashboard-mcp-server.mjs",
    "lib/capture-args.mjs",
    "lib/cdp-browser.mjs",
    "lib/dashboard-mcp-package.mjs",
    "lib/page-errors.mjs",
    "lib/page-programs.mjs",
    "subagents-live.mjs",
  ]);
});

test("DX-4232: plugin.json names the $.state contract, and the file exists", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  assert.equal(manifest.types, "./types/index.d.ts");
  assert.ok(fs.existsSync(path.join(PLUGIN, manifest.types)));
  // the contract declares the state under the plugin's own name, never the prototype's
  const contract = fs.readFileSync(path.join(PLUGIN, manifest.types), "utf8");
  assert.match(contract, /interface PluginState\s*\{\s*danxbot:/);
  assert.doesNotMatch(contract, /plan-link/);
});

// `claude` is not on PATH on every machine; CLAUDE_BIN names it (publish.sh reads the same variable).
// No CLI is a failure, never a skip: a validate nobody ran proves nothing.
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

test("DX-4232: claude plugin validate danxbot exits 0", () => {
  const found = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" });
  assert.equal(found.status, 0, `no claude CLI found as "${CLAUDE}": set CLAUDE_BIN to the claude executable (${found.error?.message ?? found.stderr})`);
  const r = spawnSync(CLAUDE, ["plugin", "validate", "danxbot"], { cwd: path.dirname(PLUGIN), encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("DX-4233: no script or hook module imports a file that does not exist", () => {
  const files = ["scripts", "hooks"]
    .flatMap((dir) => filesUnder(path.join(PLUGIN, dir)).map((rel) => path.join(PLUGIN, dir, rel)))
    .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      const candidates = [target, ...[".mjs", ".js", ".ts", ".tsx", ".json"].map((x) => target + x), path.join(target, "index.ts"), path.join(target, "index.tsx"), path.join(target, "index.d.ts"), target + ".d.ts"];
      assert.ok(candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile()), `${path.relative(PLUGIN, file)} imports missing ${m[1]}`);
    }
  }
});
