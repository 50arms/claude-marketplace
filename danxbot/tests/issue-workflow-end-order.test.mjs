import "./designated-test-container.mjs";
// DX-4014 / DX-5899: a canary dispatch once transitioned `complete` and wrote the retro BEFORE its finalize, so the retro's commits cited a
// pre-squash sha that never reached the target branch. The skill's completion text then read "Transition `complete` ...,
// then write the retro" with no merge in it. It now states one order: merge, then `complete`, then the retro. Flow step 6
// points at "Delivery", which holds the lander's steps; an operator-session sub-agent stops at its pushed card branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");
const flow = skill.slice(skill.indexOf("## Flow"), skill.indexOf("## Gates"));
const step6 = flat(flow.slice(flow.indexOf("\n6. ")));
const deliveryStart = skill.indexOf("## Delivery");
const delivery = flat(skill.slice(deliveryStart, skill.indexOf("\n## ", deliveryStart + 1)));

test("step 6 names the order merge, then complete, then the retro, and hands the steps to Delivery", () => {
  const merge = step6.indexOf("merge first");
  const complete = step6.indexOf("then `complete`");
  const retro = step6.indexOf("then the retro");
  assert.ok(merge > -1 && merge < complete && complete < retro, step6);
  assert.match(step6, /is in "Delivery" below/);
});

test("Delivery's every landing path merges before it completes and writes the retro", () => {
  const notRequired = delivery.slice(delivery.indexOf("**`required` is `false`:**"), delivery.indexOf("**`required` is `true`:**"));
  const push = notRequired.indexOf("push origin HEAD:<target branch>");
  const complete = notRequired.indexOf("Transition `complete`");
  const retro = notRequired.indexOf("write the retro");
  assert.ok(push > -1 && push < complete && complete < retro, notRequired);
  const opened = delivery.slice(delivery.indexOf("- `opened`:"));
  assert.ok(delivery.indexOf("gh pr create") < delivery.indexOf("- `opened`:"), "the pull request opens before `complete`");
  assert.ok(opened.indexOf("transition `complete`") < opened.indexOf("write the retro"), opened);
});

test("no step orders complete-then-retro without the merge in front of it", () => {
  assert.doesNotMatch(flow, /\n6\. Transition `complete`/);
});
