import "./designated-test-container.mjs";
// DX-4319 — the operator's project memory directory had grown 16 files, each
// written when an agent was corrected. A memory file reaches one project on one
// machine, so a correction saved there never reaches a dispatched worker,
// another repo or another machine (PLN-11 R-3). Two things came out of
// carrying them home, each stated ONCE in the skill that owns the subject:
//   - fix-agent-behavior is where a correction goes, and it says so in the one
//     line every session sees (its description) and in its list of homes;
//   - story points never pick the agent grade (plan-workflow, where the
//     agent grade is picked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const fixBehavior = read("../skills/fix-agent-behavior/SKILL.md");
const planWorkflow = read("../skills/plan-workflow/SKILL.md");
const issueWorkflow = read("../skills/issue-workflow/SKILL.md");

/** One line, single-spaced, so no assertion depends on where the prose wraps. */
const flat = (text) => text.replace(/\s+/g, " ");

/** The section that starts at `heading`, up to the next `## ` heading. */
function section(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start > -1, `"${heading}" exists`);
  const end = text.indexOf("\n## ", start + heading.length);
  return flat(end === -1 ? text.slice(start) : text.slice(start, end));
}

const count = (text, pattern) => [...flat(text).matchAll(new RegExp(pattern.source, "g"))].length;

const NEVER_A_MEMORY_FILE = /Never a memory file/;
const POINTS_NEVER_GRADE = /Story points decide process \(a card, gates, splitting\), never the agent grade\./;

test("the description every session sees sends a correction to the skill before it is saved anywhere", () => {
  const frontmatter = fixBehavior.slice(4, fixBehavior.indexOf("\n---", 4));
  const description = flat(parseYaml(frontmatter).description);
  assert.match(description, /^Load when the user corrects how you work, before saving the correction anywhere\./);
  assert.match(description, /never a memory file or a new skill\.$/);
});

test("the list of homes rules a memory file out", () => {
  const locate = section(fixBehavior, "## 3. Locate the target and edit it");
  assert.match(locate, NEVER_A_MEMORY_FILE);
  assert.equal(count(fixBehavior, NEVER_A_MEMORY_FILE), 1);
});

// DX-6379 / DX-6382 — the placement standard is one 50 Arms docs page, readable by every team's agents since DX-6382, so
// the skill points at it and keeps no inline copy (the page holds the homes and why a memory file is never one).
test("the list of homes reads the placement standard first and keeps no inline copy of it", () => {
  const locate = section(fixBehavior, "## 3. Locate the target and edit it");
  assert.match(locate, /`topic\.agent-context-placement`: read it first with `docs_read` \(`source: \{kind: "remote", repo: "danxbot"\}`/);
  assert.doesNotMatch(locate, /short form/);
  assert.doesNotMatch(locate, /\*\*How something works\*\*/);
});

test("the memory-file rule lives in fix-agent-behavior only", () => {
  for (const [name, text] of [["plan-workflow", planWorkflow], ["issue-workflow", issueWorkflow]]) {
    assert.doesNotMatch(flat(text), /memory file/i, name);
  }
});

test("story points never pick the agent grade: once, where plan-workflow picks the agent grade", () => {
  const subAgents = section(planWorkflow, "## Sub-agents");
  assert.match(subAgents, POINTS_NEVER_GRADE);
  assert.ok(
    subAgents.indexOf("never `general-purpose`") < subAgents.search(POINTS_NEVER_GRADE),
    "follows the sentence that picks the agent grade",
  );
  assert.equal(count(planWorkflow, POINTS_NEVER_GRADE), 1);
});
