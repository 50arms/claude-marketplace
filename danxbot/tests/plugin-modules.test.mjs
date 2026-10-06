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
// compares against, so no hand-copied copy can drift from it. A hook may be ADDED (DX-4534's Stop
// hook did) but never silently dropped or rewritten: a card that migrates or deletes one lands
// that on origin/main first, or edits this comparison in the same change.
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

test("DX-4232: hooks.json declares the module and keeps every origin/main command hook", () => {
  const hooks = readJson("hooks/hooks.json");
  assert.deepEqual(hooks.modules, ["./register.tsx"]);
  assert.ok(fs.existsSync(path.join(PLUGIN, "hooks", "register.tsx")));
  // A hook is kept when a present hook has the same event, matcher and command, bar one intended rewrite: DX-4551 replaced the repair
  // instruction in each fallback line (a personal alias and a git repair habit) with the public Claude Code uninstall/install commands;
  // launch.test.mjs pins the new text against INTEGRITY_FIX.
  const REPAIR_REWORDED = [
    "git -C ~/.claude/plugins/marketplaces/newms-plugins checkout -- danxbot`, then `update-claude-plugins`",
    "claude plugin uninstall danxbot --keep-data`, then `claude plugin install danxbot` (add `--config dashboard_url=<address>` if you had set a custom dashboard address, which a reinstall forgets)",
  ];
  const present = commandHooks(hooks);
  const kept = ([event, matcher, command]) => {
    const reworded = command.replace(REPAIR_REWORDED[0], REPAIR_REWORDED[1]);
    return present.some(([e, m, c]) => e === event && m === matcher && c === reworded);
  };
  // DX-4233 deleted the plan event bridge and its watchdog (the relay is a module listener in register.tsx now), and DX-4234 the time
  // stamp and event-hook scripts (function hooks in register.tsx now): those are the only command hooks origin/main had that this
  // branch may drop.
  const deleted = ([, , command]) => /plan-event-bridge|bridge-watchdog|inject-time\.sh|event-hook\.sh/.test(command);
  const dropped = commandHooks(originMainHooks()).filter((h) => !deleted(h) && !kept(h));
  assert.deepEqual(dropped, [], "command hooks on origin/main that hooks.json no longer has");
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

test("DX-4233: no script or hook module imports a file that does not exist", () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  const files = [...walk(path.join(PLUGIN, "scripts")), ...walk(path.join(PLUGIN, "hooks"))].filter((f) => /\.(mjs|js|ts|tsx)$/.test(f));
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
