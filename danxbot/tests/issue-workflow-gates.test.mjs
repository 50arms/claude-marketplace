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
/** One line, single-spaced, so no assertion depends on where the prose wraps. */
const flat = (text) => text.replace(/\s+/g, " ");
const gates = flat(skill.slice(start, end));

test("the brief has the sub-agent do what the gate text says, card writes included, and nothing else", () => {
  assert.match(gates, /2\. Do what that text says/);
  assert.match(gates, /including any card writes it asks for \(checklists, dependency edges\)/);
  assert.match(gates, /and nothing else\./);
});

test("nothing in the section frames a gate as review-only", () => {
  assert.doesNotMatch(gates, /that text alone/);
  // the `reviewed_ref` field name is the one allowed "review" word
  assert.doesNotMatch(gates, /\breview(?!ed_ref)/i);
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
  assert.match(gates, /3\. Record the verdict through `danxbot_api`: `PATCH \/api\/issues\/<id>\/quality-gates\/<gate>` with `\{status: "pass"\|"fail", message: "<the real finding>", reviewed_ref: "<ref>"\}`/);
  assert.match(gates, /Always send `reviewed_ref`, the ref of what the verdict covers/);
  assert.match(gates, /A gate that doesn't apply to the card is removed \(`POST` the same card route with `\{action: "remove"\}`\) with a card comment saying why — never passed/);
});

// DX-4479 — the section told an operator-session sub-agent (a builder) to spawn
// its own gate agents in the background. A background agent's completion notice
// reaches only the top-level session, so the builder waited for verdicts that
// never came (DX-4401, DX-4403, DX-4440; DX-3756 the same symptom). The builder
// now runs its PRE gates itself, pushes, reports its tip and stops; the operator
// session runs the POST gates as gate workers and says when to land.

const callers = flat(skill.slice(skill.indexOf("## Two callers"), skill.indexOf("## Flow")));
const flow = flat(skill.slice(skill.indexOf("## Flow"), skill.indexOf("## Gates")));
const planWorkflow = readFileSync(path.join(here, "../skills/plan-workflow/SKILL.md"), "utf8");
const pwStart = planWorkflow.indexOf("## Sub-agents");
const subAgents = flat(planWorkflow.slice(pwStart, planWorkflow.indexOf("\n## ", pwStart + 1)));
const creation = flat(readFileSync(path.join(here, "../skills/issue-workflow/references/card-creation-and-reference.md"), "utf8"));
const NEVER_SPAWNS = /It never spawns gate agents: a background agent's notice reaches only the top-level session\./;

test("the builder runs its PRE gates in its own context, then pushes, reports the tip SHA and stops", () => {
  assert.match(gates, /runs its PRE gates itself, in its own context/);
  assert.match(gates, /pushes its card branch, reports the tip SHA and stops/);
  assert.match(gates, NEVER_SPAWNS);
});

test("the operator session runs and re-runs the POST gates as gate workers and says when to land", () => {
  assert.match(gates, /The operator session runs each POST gate not yet `pass` through one gate worker per gate/);
  assert.match(gates, /relays the findings and says when to land/);
  assert.match(gates, /the operator session re-runs a POST gate/);
});

test("outside the never-spawns sentence, the section tells no one to spawn or dispatch a gate agent", () => {
  assert.doesNotMatch(gates.replace(NEVER_SPAWNS, ""), /\b(spawn|dispatch)/i);
});

test("the Two callers table and Flow agree with the Gates section", () => {
  assert.doesNotMatch(callers, /one sub-agent per gate/);
  assert.match(callers, /PRE gates: in your own context; POST gates: run by the operator session/);
  assert.match(callers, /push the card branch, report its tip SHA, stop; when told to land/);
  assert.match(flow, /5\. Pass its POST gates \("Gates" below\)\./);
  assert.match(flow, /an operator-session sub-agent, once told to land, commits and pushes to main/);
});

test("plan-workflow's Sub-agents section carries the matching rule once", () => {
  assert.equal([...subAgents.matchAll(/never spawns gate agents/g)].length, 1, subAgents);
  assert.match(subAgents, /A builder runs its PRE gates itself/);
  assert.match(subAgents, /you run its POST gates as gate workers and say when to land/);
});

test("the creation guide's parent-child line lists Task under an Epic and a Feature", () => {
  assert.match(creation, /Epic → Feature\/Story\/Bug\/Chore\/Task; Feature → Story\/Bug\/Chore\/Task;/);
});
