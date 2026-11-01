import "./designated-test-container.mjs";
// CP-45 — an orchestrator starts a sub-agent at the model and effort the dashboard answers for its card or gate, and passes both in the Agent
// call. So the plugin ships ONE worker, `danxbot:worker`, with no model and no effort of its own: a file that fixed either would be an agent
// type the call could silently override, and a grade could name a pair with no file. The refusal of a start without both is in
// `worker-start.test.tsx`; the orchestrator-facing text that says to pass them is checked below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "agents");

const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "an agent file opens with a frontmatter block");
  return Object.fromEntries(m[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
};

test("agents/ holds the one worker, and it fixes neither a model nor an effort", () => {
  assert.deepEqual(readdirSync(agentsDir), ["worker.md"]);
  const fm = frontmatter(readFileSync(path.join(agentsDir, "worker.md"), "utf8"));
  assert.deepEqual(Object.keys(fm).sort(), ["description", "name"], "a model or effort in the file would fix what the call passes");
  assert.equal(fm.name, "worker");
});

// The earlier Haiku workers carried a stricter brief than the others (the small model must not widen the task or guess); the one file keeps it for every model.
test("the worker keeps the Haiku workers' discipline: change only what the brief names, stop when it is ambiguous or does not match", () => {
  const text = readFileSync(path.join(agentsDir, "worker.md"), "utf8").replace(/\s+/g, " ");
  assert.match(text, /change only what it names/);
  assert.match(text, /If the brief is ambiguous or doesn't match what you find, stop and report it instead of guessing\./);
});

const planWorkflow = readFileSync(path.join(root, "skills/plan-workflow/SKILL.md"), "utf8").replace(/\s+/g, " ");
const planWorkflowRaw = readFileSync(path.join(root, "skills/plan-workflow/SKILL.md"), "utf8");

test("the moved-spawn prefix is quoted on one line, so a grep for it finds the skill", () => {
  assert.ok(planWorkflowRaw.includes("`Usage pacing moved this sub-agent`"));
});

test("plan-workflow says to pass the model and effort the dashboard answers in each call, and names no worker by its pair", () => {
  assert.match(planWorkflow, /Agent\(\{subagent_type:"danxbot:worker", model:"<model>", effort:"<effort>", prompt:"work <CARD-ID>"\}\)/);
  assert.match(planWorkflow, /start the worker with the model and effort the dashboard answers for it \(the card read answers them for a builder\), passing both in the Agent call exactly as answered; never `general-purpose`, and never a model or effort you chose yourself\./);
  assert.match(planWorkflow, /start with no model or no effort is refused, and the refusal names what to pass\./);
  assert.match(planWorkflow, /pass the model and effort the gate instruction route answers in the Agent call\./);
  assert.doesNotMatch(planWorkflow, /worker-<model>|worker-(haiku|sonnet|opus|fable)|closest worker|no worker for|nearby effort|nearest pair/i);
  const issueWorkflow = readFileSync(path.join(root, "skills/issue-workflow/SKILL.md"), "utf8");
  assert.doesNotMatch(issueWorkflow, /worker-<model>|worker-(haiku|sonnet|opus|fable)/);
});

test("plan-workflow says what a pacing-moved worker means", () => {
  assert.match(planWorkflow, /The Agent call's result then says `Usage pacing moved this sub-agent`: it did not run at the grade you chose/);
  assert.match(planWorkflow, /Run it again at its grade only when the budget leaves more than one slot free \(a spawn that takes the last free slot is moved again\)/);
  assert.doesNotMatch(planWorkflow, /once a slot is free/);
  assert.match(planWorkflow, /A sub-agent doing work that has no card of its own takes the grade of its hardest step, picked from the same ladder[^.]*; with no card to read, read the grade's model and effort from the board: `GET \/api\/boards\/<board>` with `fields\.effort_ladder`\./);
});
