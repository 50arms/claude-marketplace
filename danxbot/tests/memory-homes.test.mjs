// DX-4319 — the operator's project memory directory had grown 16 files, each
// written when an agent was corrected. A memory file reaches one project on one
// machine, so a correction saved there never reaches a dispatched worker,
// another repo or another machine (PLN-11 R-3). Two things came out of
// carrying them home, each stated ONCE in the skill that owns the subject:
//   - fix-agent-behavior is where a correction goes, and it says so in the one
//     line every session sees (its description) and in its list of homes;
//   - a card that carries gates never goes to a haiku tier (plan-workflow,
//     where the tier is picked).

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
const mantra = read("../mantra.md");

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
const GATED_NEVER_HAIKU = /A card that carries gates never goes to a `worker-haiku-\*` tier\./;

test("the description every session sees sends a correction to the skill before it is saved anywhere", () => {
  const frontmatter = fixBehavior.slice(4, fixBehavior.indexOf("\n---", 4));
  const description = flat(parseYaml(frontmatter).description);
  assert.match(description, /^Load when the operator corrects how you work, before saving the correction anywhere\./);
  assert.match(description, /never a memory file or a new skill\.$/);
});

test("the list of homes rules a memory file out and moves a correction already saved as one", () => {
  const locate = section(fixBehavior, "## 3. Locate the target and edit it");
  assert.match(locate, NEVER_A_MEMORY_FILE);
  assert.match(locate, /it reaches one project on one machine; no dispatched worker, other repo or other machine reads it/);
  assert.match(locate, /a correction already saved as one moves to its home above and the memory is deleted/);
  assert.equal(count(fixBehavior, NEVER_A_MEMORY_FILE), 1);
});

test("the memory-file rule lives in fix-agent-behavior only", () => {
  for (const [name, text] of [["mantra", mantra], ["plan-workflow", planWorkflow], ["issue-workflow", issueWorkflow]]) {
    assert.doesNotMatch(flat(text), /memory file/i, name);
  }
});

test("a gated card never goes to a haiku tier: once, where plan-workflow picks the tier", () => {
  const subAgents = section(planWorkflow, "## Sub-agents");
  assert.match(subAgents, GATED_NEVER_HAIKU);
  assert.ok(
    subAgents.indexOf("never `general-purpose`") < subAgents.search(GATED_NEVER_HAIKU),
    "follows the sentence that picks the tier",
  );
  assert.equal(count(planWorkflow, GATED_NEVER_HAIKU), 1);
  assert.doesNotMatch(flat(mantra), GATED_NEVER_HAIKU);
});
