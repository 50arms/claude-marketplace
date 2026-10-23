import "./designated-test-container.mjs";
// DX-5899 (PLAN-44 G-7) — an orchestrator briefs a worker sub-agent as `<profile> <CARD-ID>` (`gate-designer ABC-12`), and the
// sub-agent's first call fetches that agent profile's instruction for the card from the dashboard
// (`GET /api/agent-profiles/:profile/instruction?card=<id>`, the same text a dispatch of that profile receives). Every
// `danxbot:worker-*` agent carries the one line that says so, ahead of the plain card brief's fallback to issue-workflow, and a
// refused fetch ends the task instead of the worker improvising from the brief alone.

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
  "If the brief's first line is an agent profile's name and a card id (`gate-designer ABC-12`; a gate reviewer's also names its gate: `gate-reviewer ABC-12 code-quality`), your first call is `danxbot_api` `GET /api/agent-profiles/<profile>/instruction?card=<card id>`, and the `instruction` it returns is your task for that card: follow it. A refused fetch ends the task: report the refusal as given.";
const CARD_FALLBACK = "Otherwise, if the brief names a card, load `danxbot:issue-workflow` and work it.";

test("there are worker agents to check", () => {
  assert.ok(agents.length >= 7, agents.map((a) => a.name).join(", "));
});

for (const { name, text } of agents) {
  test(`${name}: a profile brief's first call is the profile fetch for its card, before the card-brief fallback`, () => {
    const profile = text.indexOf(PROFILE_LINE);
    const fallback = text.indexOf(CARD_FALLBACK);
    assert.ok(profile > -1, `${name} lacks the profile-fetch line`);
    assert.ok(fallback > profile, `${name}: the issue-workflow fallback must follow the profile line`);
    assert.equal(text.split("issue-workflow").length - 1, 1, `${name} names issue-workflow once, in the fallback`);
  });
}
