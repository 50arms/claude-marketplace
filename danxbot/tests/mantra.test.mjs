// DX-4144 (DX-4066 operator decisions) — ONE mantra for every agent: danxbot
// seeds the `mantra` reminder row from this file and every reader (operator
// session, sub-agent, dispatched worker) receives it. The operator-only rules
// (a question is not a stop, worktrees, chat with the operator) moved into
// `plan-workflow`, the operator session's own skill, and the mantra's rules are
// stated once (PLN-11 R-22): a moved rule must not survive in the mantra.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mantra = readFileSync(path.join(here, "../mantra.md"), "utf8");
const planWorkflow = readFileSync(path.join(here, "../skills/plan-workflow/SKILL.md"), "utf8");

const ruleTitles = [...mantra.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]);

/** The text of one numbered rule, up to the next numbered rule. */
function rule(n) {
  const start = mantra.search(new RegExp(`^${n}\\. `, "m"));
  assert.ok(start > -1, `rule ${n} exists`);
  const rest = mantra.slice(start + 1);
  const next = rest.search(/^\d+\. /m);
  return next === -1 ? mantra.slice(start) : mantra.slice(start, start + 1 + next);
}

test("the mantra states exactly five rules, in order", () => {
  assert.deepEqual(ruleTitles, ["Orchestrate.", "Evidence.", "Decide, don't wait.", "Zero context.", "Craft."]);
});

test("rule 1 holds for every agent: no main-session qualifier, and an agent that cannot spawn sub-agents works itself", () => {
  const orchestrate = rule(1);
  assert.doesNotMatch(orchestrate, /main session/);
  assert.match(orchestrate, /`danxbot:worker-\*`/);
  assert.match(orchestrate, /cannot spawn sub-agents does the work itself/);
});

test("rule 3 routes a human decision to a problem on the card, with the plan sign-off as the one exception", () => {
  const decide = rule(3);
  assert.match(decide, /problem, with solutions, on the card it\s+concerns/);
  assert.match(decide, /never a question in the\s+session/);
  assert.match(decide, /human\s+sign-off is the one exception \(`danxbot:plan-workflow`\)/);
});

const MOVED = [
  ["a question is not a stop", /A question is not a stop or a command\./],
  ["worktrees", /Worktrees you create go under the repo's git-ignored `\.claude\/worktrees\/<name>`/],
  ["chat with the operator", /They read cards, not chat\./],
  ["the orchestration loop", /Never end a turn while unblocked work could be dispatched/],
];

for (const [name, pattern] of MOVED) {
  test(`"${name}" lives in plan-workflow and not in the mantra`, () => {
    assert.match(planWorkflow, pattern);
    assert.doesNotMatch(mantra, pattern);
  });
}

test("plan-workflow points at its own worktree rule, never the mantra's", () => {
  assert.doesNotMatch(planWorkflow, /the mantra's worktree/);
});

// DX-4144 — the readers that name the registry row point at the renamed `mantra` row, never
// the retired `mantra.session_start` / `mantra.dispatch` keys.
const repoClaudeMd = readFileSync(path.join(here, "../../CLAUDE.md"), "utf8");
const eventHook = readFileSync(path.join(here, "../scripts/event-hook.sh"), "utf8");

test("CLAUDE.md and event-hook.sh name the one `mantra` row and no retired key", () => {
  for (const [name, text] of [["CLAUDE.md", repoClaudeMd], ["event-hook.sh", eventHook]]) {
    assert.doesNotMatch(text, /mantra\.(session_start|dispatch)/, name);
    assert.match(text, /`mantra` registry row|registry row `mantra`/, name);
  }
  assert.match(repoClaudeMd, /\{\{reminder:mantra\}\}/);
});
