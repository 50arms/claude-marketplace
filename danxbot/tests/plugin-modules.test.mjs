// DX-4232: the shape of the danxbot plugin once it ships a native hooks module beside its
// command hooks. The module's own behaviour is tested by `claude plugin test danxbot`
// (tests/plan-*.test.tsx); this file pins the plugin's manifest shape and that the engine's own
// validator accepts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(PLUGIN, rel), "utf8"));

// The command hooks as origin/main ships them, [event, matcher, command]: the baseline this file
// compares against, so no hand-copied copy can drift from it. DX-4232 deletes nothing; a card that
// migrates a hook lands it on origin/main first or edits this comparison in the same change.
function commandHooks(hooksJson) {
  const out = [];
  for (const [event, groups] of Object.entries(hooksJson.hooks)) {
    for (const group of groups) for (const h of group.hooks) out.push([event, group.matcher ?? null, h.command]);
  }
  return out;
}

function originMainHooks() {
  const r = spawnSync("git", ["show", "origin/main:danxbot/hooks/hooks.json"], { cwd: PLUGIN, encoding: "utf8" });
  assert.equal(r.status, 0, `cannot read origin/main's hooks.json (git fetch origin first): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("DX-4232: hooks.json declares the module and keeps every command hook unchanged", () => {
  const hooks = readJson("hooks/hooks.json");
  assert.deepEqual(hooks.modules, ["./register.tsx"]);
  assert.ok(fs.existsSync(path.join(PLUGIN, "hooks", "register.tsx")));
  assert.deepEqual(commandHooks(hooks), commandHooks(originMainHooks()));
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
  assert.equal(r.status, 0, `${r.stdout}
${r.stderr}`);
});
