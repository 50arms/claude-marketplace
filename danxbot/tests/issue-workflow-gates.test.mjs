// DX-4239 — the Gates section briefed every gate sub-agent to "review the card
// against that text alone". A board's gate text can tell its reviewer to WRITE
// to the card (the test checklists, the dependency edges), so a reviewer
// briefed as review-only either skipped those writes or contradicted its
// brief. The brief now hands the sub-agent the gate text as its whole job,
// card writes included. Each board owns what a gate does (DX-3544), so the
// section names no gate and copies none of a gate's behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8");
const mantra = readFileSync(path.join(here, "../mantra.md"), "utf8");

const start = skill.indexOf("## Gates");
const end = skill.indexOf("\n## ", start + 1);
assert.ok(start > -1 && end > start, "the skill has a `## Gates` section followed by another section");
// One line, single-spaced, so no assertion depends on where the prose wraps.
const gates = skill.slice(start, end).replace(/\s+/g, " ");

test("the brief has the sub-agent do what the gate text says, card writes included, and nothing else", () => {
  assert.match(gates, /2\. Do what that text says/);
  assert.match(gates, /including any card writes it asks for \(checklists, dependency edges\)/);
  assert.match(gates, /and nothing else\./);
});

test("nothing in the section frames a gate as review-only", () => {
  assert.doesNotMatch(gates, /that text alone/);
  assert.doesNotMatch(gates, /\breview/i);
});

test("the section names no gate and copies no gate's behaviour or mantra rule", () => {
  for (const owned of ["plan-tdd", "plan-dependency", "Feature Tests", "E2E Tests", "depends_on", "conflict_on"]) {
    assert.ok(!gates.includes(owned), `"${owned}" belongs to the board's gate text, not the skill`);
  }
  const ruleTitles = [...mantra.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]);
  assert.ok(ruleTitles.length > 0, "the mantra's rule titles were found");
  for (const title of ruleTitles) {
    assert.ok(!gates.includes(title), `the mantra rule "${title}" is not restated`);
  }
});

test("the brief still fetches the board's gate text, records the verdict and removes a gate that doesn't apply", () => {
  assert.match(gates, /1\. Fetch the board's gate text through `danxbot_api`: `GET \/api\/quality-gates\/<gate>\/instruction\?board=<the board the card lives on, as repo:slug>`/);
  assert.match(gates, /3\. Record the verdict through `danxbot_api`: `PATCH \/api\/issues\/<id>\/quality-gates\/<gate>` with `\{status: "pass"\|"fail", message: "<the real finding>"\}`/);
  assert.match(gates, /A gate that doesn't apply to the card is removed \(`POST` the same card route with `\{action: "remove"\}`\) with a card comment saying why — never passed/);
});
