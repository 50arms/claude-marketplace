import "./designated-test-container.mjs";
// CP-33 (danxbot DX-6417, DEC-95) — a decision record is the default home for anything important
// about a card; a card's description holds the background of the ask, and the card page lists the
// card's decisions (ref and title) under the description, so the description never restates a
// decision or a solution detail. The plugin's skills say it in danxbot's own words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, "..", rel), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const issueWorkflow = flat(read("skills/issue-workflow/SKILL.md"));
const cardCreation = flat(read("skills/issue-workflow/references/card-creation-and-reference.md"));
const planWorkflow = flat(read("skills/plan-workflow/SKILL.md"));

test("issue-workflow's Decisions line: a decision record is the default home, the description is the background, the card page lists the decisions under it", () => {
  const from = issueWorkflow.indexOf("**Decisions**");
  const line = issueWorkflow.slice(from, issueWorkflow.indexOf("**Dependencies**", from));
  assert.match(line, /a decision record is the default home for anything important about a card/);
  assert.match(line, /with a brief `title` \(at most 80 characters\), its description in `text`/);
  assert.match(line, /A card's description holds the background of the ask: what it is and why, who it is for, its timing and importance, and anything else a person needs to understand it\./);
  assert.match(line, /The solution lives in its AC and its decision records, and the card page lists every decision \(its `DEC-<n>` ref and title\) under the description, so the description never restates a decision or a solution detail\./);
  assert.doesNotMatch(issueWorkflow, /says what to build and names the record/);
});

test("card creation says what goes where: the description is the background, the AC and decision records hold what the card must do", () => {
  assert.match(cardCreation, /\*\*What goes where\.\*\* A card's description is the background of the ask; what it must do goes in its AC and decision records, which the card page lists under the description/);
});

test("plan-workflow's Where things go: the decision record is the default home and the card description is the background", () => {
  const where = planWorkflow.slice(planWorkflow.indexOf("## Where things go"), planWorkflow.indexOf("## The user"));
  assert.match(where, /decision record on the card = a consequential decision, the default home for anything important about a card/);
  assert.match(where, /card description = the background of the ask, never a decision or a solution detail \(the card page lists the card's decisions under it\)/);
});
