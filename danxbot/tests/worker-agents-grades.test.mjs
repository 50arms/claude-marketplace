import "./designated-test-container.mjs";
// CP-45 — an orchestrator starts a worker at the model and effort a grade means, so every pair the dashboard's agent grades can name needs a
// `danxbot:worker-<model>-<effort>` agent: a grade whose pair has none would run above or below what the database says (R-6), and a gate
// run above its grade spends tokens the plan is cutting.
//
// The pairs are danxbot's: a grade stores one model line and one effort knob. THE TWO LISTS BELOW ARE COPIES of danxbot's
// `MODEL_LINES` (src/agent/model-lines.ts) and `EFFORT_KNOBS` (src/agent/effort-knobs.ts), because this repo cannot import them; a
// line or knob danxbot adds is added here in the same release, and this test then fails until the workers exist.
//
// `minimal` has no sub-agent form: for a sonnet/opus/fable line it means "send no effort at all, the model's default applies" and for haiku
// "extended thinking off", while an agent file's `effort` field takes only low..max and a file without one runs at the session's usual
// effort, which is not the model's default. A grade stored at `minimal` therefore names a pair no worker can run; that is danxbot's to settle
// (see the CP-45 report), not something to approximate with a nearby worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../agents");
const MODEL_LINES = ["haiku", "sonnet", "opus", "fable"];
const EFFORT_KNOBS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const NO_SUBAGENT_FORM = ["minimal"];
const LABELS = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus", fable: "Fable" };

const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "an agent file opens with a frontmatter block");
  return Object.fromEntries(m[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
};

const files = readdirSync(agentsDir).filter((n) => n.endsWith(".md"));
const pairs = MODEL_LINES.flatMap((model) => EFFORT_KNOBS.filter((e) => !NO_SUBAGENT_FORM.includes(e)).map((effort) => ({ model, effort })));

for (const { model, effort } of pairs) {
  test(`${model} at ${effort} effort has a worker that runs at exactly that pair`, () => {
    const name = `worker-${model}-${effort}`;
    assert.ok(files.includes(`${name}.md`), `no agents/${name}.md: a grade naming ${model} at ${effort} would have no worker`);
    const fm = frontmatter(readFileSync(path.join(agentsDir, `${name}.md`), "utf8"));
    assert.equal(fm.name, name);
    assert.equal(fm.model, model);
    assert.equal(fm.effort, effort);
    assert.equal(fm.description, `'${LABELS[model]}, ${effort} effort.'`, "a description names only the pair: the pair is chosen from the grade, never from a use case");
  });
}

test("there is no worker outside the pairs the grades can name", () => {
  assert.deepEqual(files.sort(), pairs.map(({ model, effort }) => `worker-${model}-${effort}.md`).sort());
});

const planWorkflow = readFileSync(path.join(agentsDir, "../skills/plan-workflow/SKILL.md"), "utf8").replace(/\s+/g, " ");

test("plan-workflow says every grade has an exact worker, and what a pacing-moved worker means", () => {
  assert.match(planWorkflow, /Every model \(`haiku`, `sonnet`, `opus`, `fable`\) and effort \(`low`, `medium`, `high`, `xhigh`, `max`\) a grade can name has its worker, so the match is always exact: never a nearby effort or model\./);
  assert.match(planWorkflow, /The Agent call's result then says `Usage pacing moved this sub-agent`: it did not run at the grade you chose/);
  assert.match(planWorkflow, /Run it again at its grade only when the budget leaves more than one slot free \(a spawn that takes the last free slot is moved again\)/);
  assert.doesNotMatch(planWorkflow, /once a slot is free/);
  assert.match(planWorkflow, /A sub-agent doing work that has no card of its own takes the grade of its hardest step, read from the same ladder/);
  assert.doesNotMatch(planWorkflow, /nearest worker|closest worker|no worker for/i);
});
