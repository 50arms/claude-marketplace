import "./designated-test-container.mjs";
// DX-5324 (follows DX-5323) — a card's comments are the conversation between people and
// agents; an agent's working log (progress, evidence, handoffs, blockers, gate notes) is an
// agent note, written through `POST /api/issues/:id/notes`. Every plugin text that tells an
// agent where to put its log says so, and none still sends the log to a comment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, "..", rel), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const planWorkflow = flat(read("skills/plan-workflow/SKILL.md"));
const issueWorkflow = flat(read("skills/issue-workflow/SKILL.md"));
const cardCreation = flat(read("skills/issue-workflow/references/card-creation-and-reference.md"));
const compaction = flat(read("skills/prepare-for-compaction/SKILL.md"));

test("plan-workflow sends the working log, handoffs and blockers to agent notes and keeps comments for a person", () => {
  assert.match(planWorkflow, /agent note on the card \(`POST \/api\/issues\/:id\/notes`\) = your working log: progress, evidence, status, local state, handoffs, blockers; card comment = talking with a person \(a reply to what they wrote or asked\)/);
  // a pacing stop records nothing (operator rule, 2026-10-25)
  assert.match(planWorkflow, /\*\*When pacing stops you, just stop\.\*\*.*Record nothing \(no agent note, no block, no problem, no pause call, no work-in-progress commit\)/);
  assert.doesNotMatch(planWorkflow, /as paused in an agent note|saying what is paused/);
  assert.match(planWorkflow, /the newest handoff agent note \(`agent_notes` on the card read\)/);
  assert.match(planWorkflow, /write each real blocker \(card id, open problem, user action\) to an agent note on that card/);
  assert.match(planWorkflow, /after the handoff agent note, call `plan_connect\(\{plan_id, disconnect: true\}\)`/);
  assert.match(planWorkflow, /Record why on the card first \(a problem, an agent note, `depends_on`, or the real block\)/);
  assert.doesNotMatch(planWorkflow, /card comment = progress|handoff comment|to a card comment/);
});

test("issue-workflow splits Mechanics into Comments (a person) and Agent notes (the working log)", () => {
  assert.match(issueWorkflow, /\*\*Comments\*\* — only for talking with a person: a reply to what they wrote or asked\./);
  assert.match(issueWorkflow, /\*\*Agent notes\*\* — your working log on the card, `POST \/api\/issues\/:id\/notes` `\{text\}`: progress, evidence, gate results, handoffs, blockers; trace/);
  assert.doesNotMatch(issueWorkflow, /Docs impact/);
  assert.match(issueWorkflow, /\*\*Decisions\*\* — a durable decision goes in the card's description or AC, never in a comment or agent note alone\./);
  assert.match(issueWorkflow, /Read the card with its description, AC, comments, agent notes and dependencies/);
  assert.match(issueWorkflow, /`Notes from Phase N` as an agent note on the next phase card/);
  assert.doesNotMatch(issueWorkflow, /\*\*Comments\*\* — trace, audit and context/);
  // "Needing a human" is the one place that says an ask for a person is a problem.
  const mechanics = issueWorkflow.slice(issueWorkflow.indexOf("## Mechanics"), issueWorkflow.indexOf("## Building"));
  assert.doesNotMatch(mechanics, /is a problem/);
  assert.match(issueWorkflow, /Genuinely need a human → open a problem on the card/);
  assert.match(cardCreation, /A card never edits docs pages\. It records one docs proposal per page it changes, through `danxbot_api` `POST \/api\/issues\/<card id>\/docs-proposals`/);
  assert.doesNotMatch(cardCreation, /Docs impact/);
});

test("prepare-for-compaction writes the handoff state as an agent note", () => {
  assert.match(compaction, /\*\*Write the handoff as an agent note\*\* on each card in flight \(`POST \/api\/issues\/:id\/notes`\)/);
  assert.match(compaction, /record the SHA in an agent note on its card/);
});
