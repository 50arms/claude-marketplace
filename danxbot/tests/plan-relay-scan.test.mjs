// DX-4233 (R-1, R-2): the plan event relay is the module's own loop on the session's danx-dashboard MCP server. It spawns nothing
// and writes no state file, and no trace of the deleted bridge / watchdog process design is left in the plugin's code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir` (relative to the plugin root) whose name ends in one of `exts`. */
function files(dir, exts) {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...files(rel, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

const read = (rel) => readFileSync(path.join(root, rel), "utf8");

/** The relay block of register.tsx: from its banner to the session.start hook that follows it. */
function relayBlock() {
  const src = read("hooks/register.tsx");
  const from = src.indexOf("// ---- DX-4233: the plan event relay");
  const to = src.indexOf("async function onSessionStart");
  assert.ok(from > -1 && to > from, "the relay block is found by its banner and the session.start hook after it");
  return src.slice(from, to);
}

const relaySources = () => [["register.tsx relay block", relayBlock()], ...files("hooks/relay", [".ts"]).map((f) => [f, read(f)])];

test("R-1 / R-2: the relay's one outside call is plan_events_wait on the plugin's dashboard server, and no process, state file or bridge trace exists anywhere", () => {
  const block = relayBlock();
  const calls = [...block.matchAll(/\$\.mcp\.call\(/g)];
  assert.equal(calls.length, 1, "exactly one dashboard call in the relay block");
  assert.match(block, /\$\.mcp\.call\(SERVER, RELAY_TOOL,/);
  assert.match(read("hooks/relay/config.ts"), /RELAY_TOOL = 'plan_events_wait'/);

  for (const [name, src] of relaySources()) {
    assert.doesNotMatch(src, /\$\.process\b|child_process|\bspawn\b|\bexec(Sync|File)?\(/, `${name} starts no process`);
    assert.doesNotMatch(src, /node:fs|\bfs\b|writeFile|readFile|mkdir|\bunlink|\brename/, `${name} touches no file`);
    assert.doesNotMatch(src, /process\.env|process\.pid|process\.kill/, `${name} reads no process state`);
  }

  const sources = [...files("hooks", [".ts", ".tsx", ".json"]), ...files("scripts", [".mjs", ".sh"])];
  assert.ok(sources.length > 10, "the scan covers the plugin's hooks and scripts");
  for (const rel of sources) {
    const src = read(rel);
    assert.doesNotMatch(src, /plan-event-bridge/, `${rel} handles no plan-event-bridge directory`);
    assert.doesNotMatch(src, /bridge-watchdog|bridge-state|bridge-restart-decision|failure-notice/, `${rel} names no deleted bridge file`);
    assert.doesNotMatch(src, /\}\.(pid|lock|started|connected|stopped|watchdog)|["'][\w-]+\.(pid|lock|started|connected|stopped|watchdog)["']/, `${rel} writes no pid / lock / started / connected / stopped / watchdog file`);
  }
});
