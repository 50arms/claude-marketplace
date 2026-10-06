// DX-4014 (DX-3678 comment 8974, W-14/W-15) — a canary `work` dispatch
// transitioned `complete` and wrote the retro BEFORE `agent-finalize.sh`, so
// `retro.commits[]` cited a pre-squash sha that never reached `origin/main`.
// This skill's completion step read "Transition `complete` ..., then write the
// retro (last ...)" with no merge in it, while danxbot's `work` profile puts
// the finalize first. Both now state one order: merge, then `complete`, then
// the retro.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8");
const flow = skill.slice(skill.indexOf("## Flow"), skill.indexOf("## Gates"));
const step6 = flow.slice(flow.indexOf("\n6. "));

test("the completion step merges before it completes and writes the retro", () => {
  const finalize = step6.indexOf("`agent-finalize.sh`");
  const push = step6.indexOf("pushes to the target");
  const complete = step6.indexOf("`complete`");
  const retro = step6.indexOf("write the retro");
  assert.ok(finalize > -1 && push > -1 && complete > -1 && retro > -1, step6);
  assert.ok(finalize < complete && push < complete, "the merge comes before `complete`");
  assert.ok(complete < retro, "`complete` comes before the retro");
  assert.match(step6, /citing the sha now on the target branch/);
});

test("no step orders complete-then-retro without the merge in front of it", () => {
  assert.doesNotMatch(flow, /\n6\. Transition `complete`/);
});
