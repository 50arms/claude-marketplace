import "./designated-test-container.mjs";
// DX-5899 (PLAN-44 G-7) — an orchestrator briefs a worker sub-agent as `<profile> <CARD-ID>` (`gate-designer ABC-12`), and the
// sub-agent's first call fetches that agent profile's instruction for the card from the dashboard
// (`GET /api/agent-profiles/:profile/instruction?card=<id>`, the same text a dispatch of that profile receives). A refused fetch ends
// the task instead of the worker improvising from the brief alone.
// CP-109 (DEC-832): a brief may name a plan instead (`research PLAN-122`, `?plan=PLAN-<n>`), the call is made again after a compaction
// (the compaction drops the mantra and role text it returned), and the bare-card fallback to issue-workflow is gone: every brief
// carries a profile (DX-6709).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../agents");
const agents = readdirSync(agentsDir)
  .filter((name) => name.startsWith("worker-") && name.endsWith(".md"))
  .map((name) => ({ name, text: readFileSync(path.join(agentsDir, name), "utf8").replace(/\s+/g, " ") }));

const PROFILE_LINE =
  "If the brief's first line is an agent profile's name and what it is for, a card or a plan (`work ABC-12`, `research PLAN-<n>`; a gate reviewer's also names its gate: `gate-reviewer ABC-12 code-quality`), your first call is `50arms_api` `GET /api/agent-profiles/<profile>/instruction?card=<card id>` (for a plan `?plan=PLAN-<n>`; a gate reviewer adds `&gate=<gate>`, the gate its brief names), and the `instruction` it returns is your task: follow it. Make that call again whenever your conversation is compacted, since the compaction drops what it returned. A refused fetch ends the task: report the refusal as given.";

test("there are worker agents to check", () => {
  assert.ok(agents.length >= 7, agents.map((a) => a.name).join(", "));
});

for (const { name, text } of agents) {
  test(`${name}: a profile brief's first call is the profile fetch for its card or plan, made again after a compaction`, () => {
    assert.ok(text.includes(PROFILE_LINE), `${name} lacks the profile-fetch line`);
  });

  test(`${name}: no fallback serves a brief without a profile`, () => {
    assert.ok(!text.includes("issue-workflow"), `${name} still sends a bare card brief to issue-workflow`);
    assert.ok(!text.includes("Otherwise, if the brief names a card"), `${name} still carries the no-profile fallback`);
  });
}
