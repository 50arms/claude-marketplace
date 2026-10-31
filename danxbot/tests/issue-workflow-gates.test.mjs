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
  assert.doesNotMatch(gates.replaceAll("review grade", ""), /\breview(?!ed_ref)/i);
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

test("the operator session runs every gate on its review grade; the builder only builds, then pushes, reports the tip SHA and stops", () => {
  assert.match(gates, /PRE gates run before the builder starts; POST gates run on its pushed tip\. The builder only builds, at its card's build grade, and a gate never changes that grade\./);
  assert.match(gates, /A builder pushes its card branch, reports the tip SHA and stops/);
});

test("the operator session runs and re-runs the gates as gate workers, then lands the branch itself", () => {
  assert.match(gates, /The operator session runs each gate not yet `pass` \(all but `plan-design`, below\) through its own gate worker, at the gate's review grade, which the board sets: the gate instruction route answers it with its model and effort when the worker starts/);
  assert.match(gates, /briefed by profile and card \(plan-workflow "Sub-agents"\); the operator session sends the builder the findings to fix, and lands the branch once every gate passes \("Delivery" below\)\./);
  assert.match(gates, /the operator session re-runs a POST gate/);
});

test("the section tells no one to spawn or dispatch a gate agent", () => {
  assert.doesNotMatch(gates, /\b(spawn|dispatch)/i);
});

test("the Two callers table and Flow agree with the Gates section", () => {
  assert.doesNotMatch(callers, /one sub-agent per gate/);
  assert.match(callers, /Gates: run by the operator session, each in its own gate worker/);
  assert.match(callers, /push the card branch, report its tip SHA, stop; the operator session lands it: push to the target branch/);
  assert.match(flow, /5\. Pass its POST gates \("Gates" below\)\./);
  assert.match(flow, /An operator-session sub-agent stops at its pushed card branch: it reports the tip SHA and ends, and never lands the branch, transitions `complete` or writes the retro\./);
  assert.match(flow, /Landing is the operator session's job, for its own work and for a sub-agent's pushed card branch alike/);
});

// A builder briefed `work <CARD-ID>` runs the `work` profile, whose operator-session lines leave the landing, `complete` and the
// retro to the orchestrator. A skill line telling the sub-agent it lands when told would contradict the profile it runs.
test("no skill tells an operator-session sub-agent to land its own card when told", () => {
  for (const [name, text] of [["issue-workflow", flat(skill)], ["plan-workflow Sub-agents", subAgents]]) {
    assert.doesNotMatch(text, /told to land|says? when to land/, name);
  }
});

test("plan-workflow's Sub-agents section carries the matching rule once", () => {
  assert.match(subAgents, /The builder only builds, at its card's build grade\. You run each gate not yet `pass` through its own gate worker, briefed `gate-reviewer <CARD-ID> <gate>`, at the gate's review grade, which the board sets: when you start its worker, read its model and effort from the gate instruction route's answer, and pick the matching `danxbot:worker-<model>-<effort>`\./);
  assert.match(subAgents, /Once the POST gates pass, land it and complete the card\./);
  assert.match(subAgents, /Story points decide process \(a card, gates, splitting\), never the agent grade\./);
});

test("the creation guide points at GET /api/card-types for the parent-child rules", () => {
  assert.match(creation, /GET \/api\/card-types/);
});

test("the creation guide carries no hard-coded parent-child list", () => {
  assert.doesNotMatch(creation, /Epic → Feature\/Story\/Bug\/Chore\/Task/);
  assert.doesNotMatch(creation, /Feature → Story\/Bug\/Chore\/Task/);
});

// A gate that only a person's answer passes takes no recorded verdict: the server refuses its PATCH for every caller,
// and the person's choice passes it. DX-4734 put the designer's trigger, brief and procedure in these skills; DX-5899
// (PLAN-44) moves what a designer does into the `gate-designer` profile its brief fetches. The skills keep only who starts
// it, when, at which agent grade, and its `gate-designer <CARD-ID>` brief, each said once.
test("a gate only a person's answer passes is never recorded by the agent, and the builder never runs plan-design", () => {
  assert.match(gates, /A gate that only a person's answer passes takes no recorded verdict: its `PATCH` is refused for every caller\./);
  assert.match(gates, /`plan-design` is one: the builder never runs it, the operator session starts its designer \(plan-workflow "Sub-agents"\), and only a person's choice of a design on the card passes it\./);
  assert.match(gates, /not yet `pass` \(all but `plan-design`, below\)/);
});

test("plan-workflow starts the designer once, briefed gate-designer <CARD-ID> at the gate's review grade", () => {
  assert.match(subAgents, /A card carrying `plan-design` goes to no builder until a person chooses a design\./);
  assert.match(subAgents, /Once the PRE gates before it have passed and it carries no design yet, start its designer, unless one you started is still on it: `gate-designer <CARD-ID>`, with the model and effort the gate's review grade means, read from the gate instruction route\. Run it again only for a design event above that owes it a turn, or for a question about how something looks or behaves on screen while designs are on \(mantra item 3\), even when its design gate has already passed, whoever found it \(you, a reviewer's `fail`\)\. Write the question in an agent note on the card first: the brief is only `gate-designer <CARD-ID>`, so the designer reads it from the card\. A builder that meets one makes the design itself and reports what it published: that card now waits on its design problem, so run no POST gate on its tip and release the card\./);
  assert.doesNotMatch(gates, /Once the PRE gates before it have passed/);
});

test("a question about how something looks is a design, never a text problem, and the agent working the card makes it", () => {
  const human = flat(skill.slice(skill.indexOf("## Needing a human"), skill.indexOf("## Claiming")));
  assert.match(human, /How something looks or behaves on screen is never a text problem while designs are on: it is a design on the card, even when its design gate has passed \(mantra item 3\)\./);
  assert.match(human, /The agent working the card makes that design itself: fetch `GET \/api\/agent-profiles\/gate-designer\/instruction\?card=<card id>`, build the design as it says, publish it to the card with `mini_app_publish` and stop\. You sign no gate and you end as Flow step 6 says, naming what you published: the design problem holds the card until a person chooses\. An orchestrator may start `gate-designer` for it instead, to keep the build out of its own context\./);
  assert.match(flat(skill), /is a design, never a text problem: mantra item 3\) → open a problem with solutions/);
  assert.match(flat(planWorkflow), /problem on the card it concerns = user question \(while designs are on, a question about how something looks or behaves on screen is a design, never a text problem: mantra item 3\);/);
  assert.match(flat(planWorkflow), /\(a point still open is a problem on that card, or a design: mantra item 3\)/);
  assert.match(flat(planWorkflow), /or open a problem on it when only a person can decide \(or a design: mantra item 3\)\./);
  for (const [name, text] of [["issue-workflow", flat(skill)], ["plan-workflow", flat(planWorkflow)]]) {
    assert.doesNotMatch(text, /is a design, never a problem|: run `gate-designer`\.|a builder's report|reports it to the orchestrator/, name);
  }
});

test("what a designer does lives only in its profile: neither skill repeats it", () => {
  const claiming = flat(skill.slice(skill.indexOf("## Claiming"), skill.indexOf("## When to block")));
  const designerOnly = [
    /<CARD-ID> plan-design/,
    /claims nothing/,
    /mini-app usage/,
    /design and revision numbers/,
    /reports the designs? it published/,
    /A design it cannot build/,
    /handed a card id and `plan-design`/,
  ];
  for (const [name, text] of [["issue-workflow", flat(skill)], ["plan-workflow Sub-agents", subAgents]]) {
    for (const re of designerOnly) assert.doesNotMatch(text, re, `${name}: ${re}`);
  }
  assert.doesNotMatch(flow, /designer/);
  assert.doesNotMatch(claiming, /designer/);
  assert.match(claiming, /A builder whose `pickup` is refused 409 `design_not_chosen` stops and reports it: the card waits on a person choosing a design\./);
});

// DX-5899 (PLAN-44 G-7): every profile-shaped job (builder, gate reviewer, designer) is briefed `<profile> <CARD-ID>`, and the
// sub-agent's first call fetches that profile's instruction for the card.
test("plan-workflow delegates every profile-shaped job as <profile> <CARD-ID>, never a hand-written brief", () => {
  assert.match(subAgents, /Delegate by agent profile and card: the brief's first line is `<profile> <CARD-ID>`, and the sub-agent's first call fetches that profile's instruction for the card, which is its whole task, so the brief repeats nothing the profile or the card says\./);
  assert.match(subAgents, /`Agent\(\{subagent_type:"danxbot:worker-<model>-<effort>", prompt:"work <CARD-ID>"\}\)`/);
  const briefs = [...subAgents.matchAll(/`((?:work|gate-reviewer|gate-designer) <CARD-ID>[^`]*)`|prompt:"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual([...new Set(briefs)].sort(), ["gate-designer <CARD-ID>", "gate-reviewer <CARD-ID> <gate>", "work <CARD-ID>"]);
  assert.doesNotMatch(subAgents, /Delegate by card id/);
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
