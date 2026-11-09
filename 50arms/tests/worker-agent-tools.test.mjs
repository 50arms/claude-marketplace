import "./designated-test-container.mjs";
// CP-56 — every worker agent lists only the tools a worker uses (work, gate-reviewer, dependency-reviewer and gate-designer profiles), so a sub-agent starts with fewer tool definitions. Agent stays: the body tells a worker it may fan out. MCP tools are named by one wildcard per server, the platform server under both its names: the plugin's (`plugin_50arms_platform`) and a dispatched agent's clean-room one (`platform`). A list naming each MCP tool saved a sub-agent no more but added 4,518 tokens to every orchestrator request, because each `tools:` line is printed in the orchestrator's agent listing; the wildcards add 672 (DX-6805 trials d10b1321, ce508473).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../agents");
const files = readdirSync(agentsDir).filter((n) => n.startsWith("worker-") && n.endsWith(".md"));

const toolsOf = (name) => {
  const m = readFileSync(path.join(agentsDir, name), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith("tools:"));
  assert.ok(line, `${name} has a tools line`);
  return line.slice("tools:".length).trim().split(", ");
};

test("there are seven worker agents", () => assert.equal(files.length, 7));

for (const name of files) {
  test(`${name}: lists the worker tools and no others`, () => {
    const tools = toolsOf(name);
    for (const t of ["Agent", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "ToolSearch"]) assert.ok(tools.includes(t), `${t} stays`);
    for (const t of ["Artifact", "NotebookEdit", "WebSearch"]) assert.ok(!tools.includes(t), `${t} is not a worker tool`);
    assert.deepEqual(tools.filter((t) => t.startsWith("mcp__")).sort(), ["mcp__Claude_Browser__*", "mcp__platform__*", "mcp__plugin_50arms_platform__*"], "MCP tools are named only by one wildcard per server");
    assert.equal(new Set(tools).size, tools.length, "no tool is listed twice");
  });
}

test("all seven agents list the same tools", () => {
  const first = toolsOf(files[0]).join(",");
  for (const n of files) assert.equal(toolsOf(n).join(","), first, n);
});
