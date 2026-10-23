import "./designated-test-container.mjs";
// DX-4144 / CP-4 — the mantra's text lives in danxbot's reminder seed, and its own wording is
// pinned by danxbot's mantra-wording test. What stays here is the skill side: the operator-only
// rules (a question is not a stop, worktrees, chat with the operator, the parked-card rule)
// live once, in `plan-workflow`, the operator session's own skill (PLN-11 R-22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const planWorkflow = readFileSync(path.join(here, "../skills/plan-workflow/SKILL.md"), "utf8");

const MOVED = [
  ["a question is not a stop", /A question is not a stop or a command\./],
  ["worktrees", /Worktrees you create go under the repo's git-ignored `\.claude\/worktrees\/<name>`/],
  ["chat with the operator", /They read cards, not chat\./],
  ["the orchestration loop", /Never end a turn while unblocked work could be dispatched/],
];

for (const [name, pattern] of MOVED) {
  test(`"${name}" lives in plan-workflow`, () => {
    assert.match(planWorkflow, pattern);
  });
}

// DX-4305 — two retired PLAN-2 working rules, each kept in ONE home. R-36 (a parked card) is
// plan-workflow's; R-23's "a statement in a rules file is not evidence" is already rule 2, so
// rule 2 must keep saying it or the "already covered" verdict stops being true.
const PARKED_CARD = /An archived \(Backlog\) card was parked on\s+purpose/;

test("the parked-card rule lives once in plan-workflow § Actionable work", () => {
  const start = planWorkflow.indexOf("## Actionable work");
  const actionable = planWorkflow.slice(start, planWorkflow.indexOf("\n## ", start + 1));
  assert.match(actionable, PARKED_CARD);
  assert.match(actionable, /read why in its comments and agent notes before reopening it/);
  assert.match(actionable, /a park the user made is theirs\s+to lift/);
  assert.equal([...planWorkflow.matchAll(new RegExp(PARKED_CARD.source, "g"))].length, 1);
});

test("plan-workflow points at its own worktree rule, never the mantra's", () => {
  assert.doesNotMatch(planWorkflow, /the mantra's worktree/);
});

// DX-4144 — the readers that name the registry row point at the renamed `mantra` row, never
// the retired `mantra.session_start` / `mantra.dispatch` keys.
const repoClaudeMd = readFileSync(path.join(here, "../../CLAUDE.md"), "utf8");

test("CLAUDE.md names the one `mantra` row, its home in danxbot's seed, and no retired key", () => {
  assert.doesNotMatch(repoClaudeMd, /mantra\.(session_start|dispatch)/);
  assert.match(repoClaudeMd, /`mantra` registry row|registry row `mantra`/);
  assert.match(repoClaudeMd, /\{\{reminder:mantra\}\}/);
  assert.match(repoClaudeMd, /src\/issues\/reminders\/seed\.yaml/);
});
