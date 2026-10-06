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
  // A hook is kept when a present hook has the same event, matcher and command. The one intended rewrite: DX-4578 narrowed the
  // plan_connect matcher from the three server prefixes to the plugin's (the matcher test below pins the new one).
  const PLAN_CONNECT_NARROWED = [/^\^\(mcp__.*plan_connect\)\$$/, "^mcp__plugin_danxbot_danx-dashboard__plan_connect$"];
  // The other: DX-4551 replaced the repair instruction in each fallback line (a personal alias and a git repair habit) with the public
  // Claude Code uninstall/install commands; launch.test.mjs pins the new text against INTEGRITY_FIX.
  const REPAIR_REWORDED = [
    "git -C ~/.claude/plugins/marketplaces/newms-plugins checkout -- danxbot`, then `update-claude-plugins`",
    "claude plugin uninstall danxbot --keep-data`, then `claude plugin install danxbot` (add `--config dashboard_url=<address>` if you had set a custom dashboard address, which a reinstall forgets)",
  ];
  const present = commandHooks(hooks);
  const kept = ([event, matcher, command]) => {
    const expected = matcher !== null && PLAN_CONNECT_NARROWED[0].test(matcher) ? PLAN_CONNECT_NARROWED[1] : matcher;
    const reworded = command.replace(REPAIR_REWORDED[0], REPAIR_REWORDED[1]);
    return present.some(([e, m, c]) => e === event && m === expected && c === reworded);
  };
  const dropped = commandHooks(originMainHooks()).filter((h) => !kept(h));
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

test("DX-4578: the plan_connect hook's matcher names exactly the one tool config.ts SERVER can answer to", () => {
  const config = fs.readFileSync(path.join(PLUGIN, "hooks", "plan", "config.ts"), "utf8");
  const server = /export const SERVER = '([^']+)'/.exec(config)?.[1];
  assert.ok(server, "config.ts names the one dashboard server");
  const group = readJson("hooks/hooks.json").hooks.PostToolUse.find((g) => g.hooks.some((h) => h.command.endsWith("plan-event-bridge.mjs start")));
  assert.equal(group.matcher, `^mcp__${server.replace(/:/g, "_")}__plan_connect$`);
});
