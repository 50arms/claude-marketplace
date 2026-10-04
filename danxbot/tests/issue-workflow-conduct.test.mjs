// DX-4305 — PLAN-2 was cut back to its three goals and 51 of its working rules
// were retired. Four were still true and written nowhere an agent meets them;
// each now lives once, as one sentence in the skill that owns the subject. The
// three that belong to issue-workflow are pinned here (PLAN-2 CAV-59, R-23,
// R-38); the fourth (R-36, plan-workflow) is pinned in mantra.test.mjs. R-23's
// "a statement in a rules file is not evidence" half is the mantra's Evidence
// rule, so the skill deliberately does NOT restate it (PLN-11 R-22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const skill = read("../skills/issue-workflow/SKILL.md");

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

test("the browser bullet has the agent open its own tab and pass its tabId on every call (PLAN-2 CAV-59)", () => {
  const shell = slice(skill, "## Shell");
  const bullet = shell.slice(shell.indexOf("- Browser checks:"));
  assert.match(bullet, /the in-app browser tool only, never a headed browser on the desktop/);
  assert.match(bullet, OWN_TAB);
  assert.match(bullet, /none acts on the tab the user has fronted/);
  assert.match(bullet, /close the tabs you opened/);
});

test("a comment or rule found false is corrected in the same change, and the paragraph leaves 'not evidence' to the mantra (PLAN-2 R-23)", () => {
  const existingCode = slice(skill, "**Existing code.**", "## Debugging");
  assert.match(existingCode, FIX_FALSE_TEXT);
  assert.doesNotMatch(existingCode, /not evidence|verified this turn/i);
});

test("debugging step 5 isolates two plausible producers (PLAN-2 R-38)", () => {
  const debugging = skill.slice(skill.indexOf("## Debugging"), skill.indexOf("## Git"));
  const step5 = slice(debugging, "\n5. ", "\n6. ");
  assert.match(step5, TWO_PRODUCERS);
  assert.match(step5, /green after fixing one proves nothing about the other/);
});

test("each addition is stated exactly once in issue-workflow", () => {
  for (const pattern of [OWN_TAB, FIX_FALSE_TEXT, TWO_PRODUCERS]) {
    assert.equal(count(skill, pattern), 1, String(pattern));
  }
});

test("browser-visible work keeps ONE current screenshot on the card: attach, then delete the one it supersedes", () => {
  const building = skill.slice(skill.indexOf("## Building"), skill.indexOf("## Debugging"));
  const show = building.slice(building.indexOf("**Show the work.**"));
  assert.match(show, /attach a screenshot to the card \(`attach_file`\)/);
  assert.match(show, /replace it at each milestone and at completion/);
  assert.match(show, /delete the one it supersedes/);
  assert.match(show, /never a growing list/);
  assert.match(show, /Frame the component you are\s+working on/);
  assert.match(show, /not the whole app/);
  assert.equal(count(skill, /\*\*Show the work\.\*\*/), 1);
});
