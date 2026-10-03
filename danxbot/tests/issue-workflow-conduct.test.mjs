// DX-4305 — PLAN-2 was cut back to its three goals and 51 of its working rules
// were retired. Four were still true and written nowhere an agent meets them
// (PLAN-2 CAV-59, R-23, R-38, R-36); each now lives once, as one sentence in the
// skill that owns the subject. The rest were already covered or no longer true,
// and R-23's "a statement in a rules file is not evidence" half is the mantra's
// Evidence rule, so it is deliberately NOT restated here (PLN-11 R-22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const skill = read("../skills/issue-workflow/SKILL.md");
const planWorkflow = read("../skills/plan-workflow/SKILL.md");
const mantra = read("../mantra.md");

/** One line, single-spaced, so no assertion depends on where the prose wraps. */
const flat = (text) => text.replace(/\s+/g, " ");

/** The text from `from` up to the next `until` (or the end of the file). */
function slice(text, from, until) {
  const start = text.indexOf(from);
  assert.ok(start > -1, `"${from}" exists`);
  const end = until ? text.indexOf(until, start + from.length) : -1;
  return flat(end === -1 ? text.slice(start) : text.slice(start, end));
}

const count = (text, pattern) => [...flat(text).matchAll(new RegExp(pattern.source, "g"))].length;

const OWN_TAB = /Open your own tab and pass its `tabId` on every call/;
const FIX_FALSE_TEXT = /A comment or rule you find false is corrected in the same change\./;
const TWO_PRODUCERS = /Two plausible producers → back each fix out alone and re-run/;
const PARKED_CARD = /An archived \(Backlog\) card was parked on purpose/;

test("the browser bullet has the agent open its own tab and pass its tabId on every call (PLAN-2 CAV-59)", () => {
  const shell = slice(skill, "## Shell");
  const bullet = shell.slice(shell.indexOf("- Browser checks:"));
  assert.match(bullet, /the in-app browser tool only, never a headed browser on the desktop/);
  assert.match(bullet, OWN_TAB);
  assert.match(bullet, /none acts on the tab the user has fronted/);
  assert.match(bullet, /close the tabs you opened/);
});

test("a comment or rule found false is corrected in the same change, under Existing code (PLAN-2 R-23)", () => {
  const existingCode = slice(skill, "**Existing code.**", "## Debugging");
  assert.match(existingCode, FIX_FALSE_TEXT);
});

test("debugging step 5 isolates two plausible producers, and no other step does (PLAN-2 R-38)", () => {
  const debugging = skill.slice(skill.indexOf("## Debugging"), skill.indexOf("## Git"));
  const step5 = slice(debugging, "\n5. ", "\n6. ");
  assert.match(step5, TWO_PRODUCERS);
  assert.match(step5, /green after fixing one proves nothing about the other/);
  assert.doesNotMatch(flat(debugging).replace(step5, ""), TWO_PRODUCERS);
});

test("each addition is stated exactly once in issue-workflow", () => {
  for (const pattern of [OWN_TAB, FIX_FALSE_TEXT, TWO_PRODUCERS]) {
    assert.equal(count(skill, pattern), 1, String(pattern));
  }
});

test("the parked-card rule lives in plan-workflow § Actionable work and not in the mantra (PLAN-2 R-36)", () => {
  const actionable = slice(planWorkflow, "## Actionable work", "\n## ");
  assert.match(actionable, PARKED_CARD);
  assert.match(actionable, /read why in its comments before readying it/);
  assert.match(actionable, /a park the operator made is theirs to lift/);
  assert.equal(count(planWorkflow, PARKED_CARD), 1);
  assert.doesNotMatch(flat(mantra), /parked|archived/i);
});

test("the mantra's Evidence rule still owns 'a label is not evidence', and the skill does not restate it", () => {
  const evidence = slice(mantra, "2. **Evidence.**", "\n3. ");
  assert.match(evidence, /only on what you verified this turn/);
  assert.match(evidence, /never a name, label, status field or proxy/);
  assert.doesNotMatch(flat(skill), /not evidence/i);
  assert.doesNotMatch(flat(skill), /verified this turn/);
});
