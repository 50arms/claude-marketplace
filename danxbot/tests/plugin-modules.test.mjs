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

// Every command hook the plugin shipped before the module: [event, matcher, command]. Nothing is
// deleted by DX-4232; the G-3 cards that migrate a hook edit this list in the same change.
const COMMAND_HOOKS = [
  ["UserPromptSubmit", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" --via stdout scripts/inject-time.sh UserPromptSubmit || echo '[danxbot plugin] a danxbot hook failed to run, so the plugin install may be corrupt. Fix: run `git -C ~/.claude/plugins/marketplaces/newms-plugins checkout -- danxbot`, then `update-claude-plugins`, then restart the session.'"],
  ["SessionStart", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/background-work-report.mjs session-start"],
  ["SessionStart", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/ensure-dashboard-mcp.sh --prewarm"],
  ["SessionStart", "startup|resume|compact", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" --via stdout scripts/event-hook.sh SessionStart || echo '[danxbot plugin] a danxbot hook failed to run, so the plugin install may be corrupt. Fix: run `git -C ~/.claude/plugins/marketplaces/newms-plugins checkout -- danxbot`, then `update-claude-plugins`, then restart the session.'"],
  ["SessionStart", "startup|resume|clear|compact", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" --via rewake scripts/plan-event-bridge.mjs start"],
  ["SubagentStart", ".*", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/event-hook.sh SubagentStart"],
  ["SubagentStart", ".*", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/activity-report.mjs subagent-start"],
  ["PostToolUse", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/inject-time.sh PostToolUse"],
  ["PostToolUse", "^(mcp__danx_dashboard__plan_connect|mcp__danx-dashboard__plan_connect)$", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" --via rewake scripts/plan-event-bridge.mjs start"],
  ["PostToolUse", ".*", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" --via rewake scripts/bridge-watchdog.mjs"],
  ["PostToolUse", ".*", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/background-work-report.mjs heartbeat"],
  ["PostToolUse", "Bash", "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/activity-report.mjs background-bash"],
  ["Stop", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" --via rewake scripts/bridge-watchdog.mjs"],
  ["Stop", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/background-work-report.mjs stop"],
  ["SubagentStop", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/background-work-report.mjs subagent-stop"],
  ["SubagentStop", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/activity-report.mjs subagent-stop"],
  ["StopFailure", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/background-work-report.mjs stop-failure"],
  ["SessionEnd", null, "node \"${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs\" scripts/plan-event-bridge.mjs stop"],
];

test("DX-4232: hooks.json declares the module and keeps every command hook unchanged", () => {
  const hooks = readJson("hooks/hooks.json");
  assert.deepEqual(hooks.modules, ["./register.tsx"]);
  assert.ok(fs.existsSync(path.join(PLUGIN, "hooks", "register.tsx")));
  const found = [];
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    for (const group of groups) for (const h of group.hooks) found.push([event, group.matcher ?? null, h.command]);
  }
  assert.deepEqual(found, COMMAND_HOOKS);
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
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const hasClaude = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" }).status === 0;

test("DX-4232: claude plugin validate danxbot exits 0", { skip: hasClaude ? false : "no claude CLI on PATH (set CLAUDE_BIN)" }, () => {
  const r = spawnSync(CLAUDE, ["plugin", "validate", "danxbot"], { cwd: path.dirname(PLUGIN), encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}
${r.stderr}`);
});
