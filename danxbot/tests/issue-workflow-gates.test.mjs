import "./designated-test-container.mjs";
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
// DX-5889 / CP-4: the mantra lives in danxbot's reminder seed, so its five rule titles are pinned here.
const MANTRA_RULE_TITLES = ["Orchestrate.", "Evidence.", "Decide, don't wait.", "Zero context.", "Craft."];

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
  for (const title of MANTRA_RULE_TITLES) {
    assert.ok(!gates.includes(title), `the mantra rule "${title}" is not restated`);
  }
});

test("the brief still fetches the board's gate text, records the verdict and removes a gate that doesn't apply", () => {
  assert.match(gates, /1\. Fetch the board's gate text through `danxbot_api`: `GET \/api\/quality-gates\/<gate>\/instruction\?board=<the board the card lives on, as repo:slug>`/);
  assert.match(gates, /3\. Record the verdict through `danxbot_api`: `PATCH \/api\/issues\/<id>\/quality-gates\/<gate>` with `\{status: "pass"\|"fail", message: "<the real finding>", reviewed_ref: "<ref>"\}`/);
  assert.match(gates, /Always send `reviewed_ref`, the ref of what the verdict covers/);
  assert.match(gates, /A gate that doesn't apply to the card is removed \(`POST` the same card route with `\{action: "remove"\}`\) with an agent note saying why — never passed/);
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
  assert.match(flow, /an operator-session sub-agent, once told to land, commits and pushes to the target branch/);
});

test("plan-workflow's Sub-agents section carries the matching rule once", () => {
  assert.equal([...subAgents.matchAll(/never spawns gate agents/g)].length, 1, subAgents);
  assert.match(subAgents, /A builder runs its PRE gates itself/);
  assert.match(subAgents, /you run its POST gates as gate workers and say when to land/);
});

test("the creation guide points at GET /api/card-types for the parent-child rules", () => {
  assert.match(creation, /GET \/api\/card-types/);
});

test("the creation guide carries no hard-coded parent-child list", () => {
  assert.doesNotMatch(creation, /Epic → Feature\/Story\/Bug\/Chore\/Task/);
  assert.doesNotMatch(creation, /Feature → Story\/Bug\/Chore\/Task/);
});

// A gate that only a person's answer passes takes no recorded verdict: the server refuses its PATCH for every caller,
// and the person's choice passes it. DX-4734 AC 50935: nothing told an orchestrator to start the first designer, and
// the builder's "run your PRE gates yourself" pointed it at a gate whose pickup is refused. The section names
// `plan-design` only to say WHO runs it and how a sub-agent becomes its designer; what a designer builds stays in
// the board's gate text.
test("a gate only a person's answer passes is never recorded by the agent", () => {
  assert.match(gates, /A gate that only a person's answer passes takes no recorded verdict: its `PATCH` is refused for every caller\./);
  assert.match(gates, /Publishing leaves the gate open: only a person's choice of a design on the card passes it\./);
});

test("the operator session, never the builder, runs one designer sub-agent at the gate's tier", () => {
  assert.match(gates, /runs its PRE gates itself, in its own context \(all but `plan-design`, below\)/);
  assert.match(gates, /`plan-design` is one, and the builder never runs it\. Once the PRE gates before it have passed and the card carries no design yet, the operator session runs one designer sub-agent, unless one it started is still on it, at the tier the gate's `effort_level` on the card names \(unset: `danxbot:worker-sonnet-high`, the gate-worker tier above\)\./);
});

test("Flow and Claiming exempt the designer from the claim, and a refused builder stops", () => {
  assert.match(flow, /2\. Operator-session sub-agent: claim it before any work \(below\); a `plan-design` designer claims nothing \("Gates"\)\./);
  const claiming = flat(skill.slice(skill.indexOf("## Claiming"), skill.indexOf("## When to block")));
  assert.match(claiming, /Nor does a `plan-design` designer \("Gates"\)\./);
  assert.match(claiming, /A builder whose `pickup` is refused 409 `design_not_chosen` stops and reports it: the card waits on a person choosing a design\./);
});

test("a sub-agent handed only a card id and plan-design can set itself up as the designer", () => {
  assert.match(gates, /A sub-agent handed a card id and `plan-design` is that designer: it claims nothing, fetches the gate text \(step 1\), reads the repo's mini-app usage instructions, builds and publishes as the text says, then stops and reports the design and revision numbers it published\./);
  assert.match(gates, /A design it cannot build \(no mini-app target, a build that keeps failing\) becomes an `action` problem on the card naming why, and it reports that instead\./);
});

test("plan-workflow starts the first designer, not only the re-run, with a card-id-and-gate brief", () => {
  assert.match(subAgents, /A card carrying `plan-design` goes to no builder until a person chooses a design\./);
  assert.match(subAgents, /Once the PRE gates before it have passed and it carries no design yet, run its designer, unless one you started is still on it: `Agent\(\{subagent_type:"danxbot:worker-<tier>", prompt:"<CARD-ID> plan-design"\}\)`, `<tier>` as issue-workflow "Gates" picks it\./);
  assert.match(subAgents, /It reports the designs it published or the problem it opened\. Run it again only for a design event above that owes it a turn\./);
});

test("the creation guide lists both design gates with when to add each, and builds no designer of its own", () => {
  assert.match(creation, /\| `plan-design` \| PRE \| changes what a person sees or does in a UI and its look is not settled/);
  assert.match(creation, /\| `code-design` \| POST \| is a complex UI build .* that must match its approved design closely \|/);
  assert.match(creation, /`plan-design` builds the card's designs with the repo's own mini app, and only a person choosing one passes it\./);
  assert.match(creation, /A repo whose designs are off refuses the gate: raise that as an `action` problem/);
  for (const gone of ["danxbot:design", "worker-designer"]) {
    assert.ok(!creation.includes(gone), `${gone} was planned once and is not built: the board's gate text is the designer's procedure`);
  }
});
