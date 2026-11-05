import "./designated-test-container.mjs";
// DX-4560 — a session building a card in a repo that needs review (a team's own repo) must end
// with an open pull request, never a push to the target branch, while 50 Arms' own boards keep
// pushing. The skill's "Delivery" section reads the card's resolved controls
// (git.target_branch, git.pull_request.required, git.pull_request.done_on; DX-4559) and says
// what each value does. These tests pin the contract the section states and that it stays
// general-audience text (DX-4551).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannedHits } from "../../scripts/check-general-audience.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8");
/** One line, single-spaced, so no assertion depends on where the prose wraps. */
const flat = (text) => text.replace(/\s+/g, " ");

const start = skill.indexOf("## Delivery: push or pull request");
const end = skill.indexOf("\n## ", start + 1);
assert.ok(start > -1 && end > start, "the skill has a `## Delivery` section followed by another section");
const delivery = flat(skill.slice(start, end));
const required = delivery.slice(delivery.indexOf("**`required` is `true`:**"));
/** The text of numbered step n of the `required` is `true` list. */
const step = (n) => {
  const from = required.indexOf(` ${n}. `);
  const to = required.indexOf(` ${n + 1}. `);
  return required.slice(from, to === -1 ? undefined : to);
};

test("it reads the three resolved controls from the card read", () => {
  assert.match(delivery, /`GET \/api\/issues\/<id>` with `fields \{"controls":true\}`/);
  for (const key of ["git.target_branch", "git.pull_request.required", "git.pull_request.done_on"]) {
    assert.ok(delivery.includes(`\`${key}\``), key);
  }
});

test("a missing control key opens an action problem and stops, never guessing false", () => {
  assert.match(delivery, /missing from the reply[^.]*open an `action` problem[^.]*then stop/);
  assert.match(delivery, /Never guess `false`/);
});

const notRequired = delivery.slice(delivery.indexOf("**`required` is `false`:**"), delivery.indexOf("**`required` is `true`:**"));
/** The text of numbered step n of the `required` is `false` list. */
const landStep = (n) => {
  const from = notRequired.indexOf(` ${n}. `);
  const to = notRequired.indexOf(` ${n + 1}. `);
  return notRequired.slice(from, to === -1 ? undefined : to);
};

// The section is the lander's (the operator session), written in its voice, and says how a sub-agent's pushed card branch
// reaches the target: rebase it onto the target, run the repo's finalize or push, then complete and write the retro.
test("the section is addressed to the lander, and a sub-agent never lands", () => {
  assert.match(delivery, /It is the lander's job: the operator session, landing its own work or an operator-session sub-agent's pushed card branch once every POST gate on it passes/);
  assert.match(delivery, /An operator-session sub-agent never lands: it pushes its card branch, reports the tip and stops \(Flow step 6\)\./);
  assert.doesNotMatch(delivery, /Applies to a session that lands a card/);
});

test("the order is fixed: the target branch or pull request first, then complete, then the retro", () => {
  const order = delivery.slice(delivery.indexOf("The order is fixed:"));
  const target = order.indexOf("reaches the target branch");
  const complete = order.indexOf("transitions `complete`");
  const retro = order.indexOf("the retro is written last");
  assert.ok(target > -1 && target < complete && complete < retro, order);
  assert.match(order, /citing the sha now on the target branch/);
});

test("required false: the lander rebases the card branch onto the target, tests, pushes, then completes", () => {
  assert.match(notRequired, /\*\*`required` is `false`:\*\* land the card branch on the target branch yourself\./);
  assert.ok(landStep(1).includes("git fetch origin") && landStep(1).includes("rebase origin/<target branch>"), landStep(1));
  assert.match(landStep(1), /re-run the card's tests on the result/);
  assert.match(landStep(2), /the repo's own finalize or land command/);
  assert.ok(landStep(2).includes("push origin HEAD:<target branch>"), landStep(2));
  assert.match(landStep(2), /never force it/);
  assert.match(landStep(3), /^ 3\. Transition `complete` with a summary, then write the retro citing the sha now on the target branch/);
  assert.doesNotMatch(notRequired, /commit and push to the target branch/);
});

test("required true: no gh prerequisite, the card branch is pushed with git", () => {
  assert.ok(required.includes("never pushed to"));
  assert.doesNotMatch(required, /`gh /);
  assert.match(step(1), /no GitHub CLI is needed/);
  assert.ok(step(1).includes("git push -u origin card/<card id>"), step(1));
  assert.ok(step(1).includes("never the target branch itself"), step(1));
});

test("required true: the pull request opens through the 50 Arms route, with its refusals handled", () => {
  const second = step(2);
  for (const text of ["POST /api/issues/<id>/pull-request", "with no body", "50 Arms GitHub App", "`pull_request_url`",
    "the branch is not pushed yet", "open an `action` problem", "GitHub App in Setup", "Never fall back to pushing the target branch"]) {
    assert.ok(second.includes(text), `step 2 lacks ${text}`);
  }
  assert.ok(step(1).indexOf("git push") > -1 && required.indexOf("POST /api/issues") > required.indexOf("git push"), "push before the route");
});

test("dependent_start is a control, and branch_from_dependency branches from the dependency's pull request branch", () => {
  assert.ok(delivery.includes("`git.pull_request.dependent_start`: `wait_for_merge` or `branch_from_dependency`"));
  const dep = delivery.slice(delivery.indexOf("**Dependent cards:**"));
  for (const text of ["`wait_for_merge` needs nothing from you", "`branch_from_dependency`", "`dependency_pull_requests`",
    "base your branch on `origin/<the one entry's branch>`", "opens your pull request into that branch", "Never code over a branch missing a dependency's code"]) {
    assert.ok(dep.includes(text), `lacks ${text}`);
  }
});

test("done_on opened completes the card and writes the retro", () => {
  const opened = step(3).slice(step(3).indexOf("`opened`"), step(3).indexOf("`merged`"));
  assert.match(opened, /transition `complete`/);
  assert.match(opened, /retro/);
});

test("done_on merged never completes, releases the claim, and says the person completes it", () => {
  const merged = step(3).slice(step(3).indexOf("`merged`"));
  assert.match(merged, /^`merged`: do not transition `complete`/);
  assert.match(merged, /Release your claim with `DELETE \/api\/issues\/<id>\/assigned-agent`/);
  assert.match(merged, /the card stays open \(it shows ToDo/);
  assert.doesNotMatch(merged, /In Progress/);
  assert.match(merged, /until the pull request merges/);
  assert.match(merged, /the person completes it then/);
  assert.doesNotMatch(merged, /completes when the pull request merges/);
});

test("the caller table and flow step 6 name the target branch, never main, and point at Delivery", () => {
  const row = flat(skill.split("\n").find((line) => line.startsWith("| Merge + end")));
  assert.match(row, /push to the target branch \(or open a pull request when "Delivery" below says so\)/);
  assert.doesNotMatch(row, /\bmain\b/);
  const step6 = flat(skill.slice(skill.indexOf("\n6. "), skill.indexOf("## Gates")));
  assert.match(step6, /every step of it \(merge first, then `complete`, then the retro\) is in "Delivery" below/);
  assert.doesNotMatch(step6, /origin\/main|to main/);
});

// The Git rules once told every reader to push "to the target branch, or to the card's branch", which told an operator-session
// sub-agent to push the target itself, against "push the card branch, stop".
test("Git: a sub-agent pushes only its card branch; the target receives work only through Delivery", () => {
  const from = skill.indexOf("## Git");
  const git = flat(skill.slice(from, skill.indexOf("\n## ", from + 1)));
  assert.match(git, /An operator-session sub-agent pushes only its card branch, never the target branch: the operator session lands it\./);
  assert.match(git, /The target branch receives work only as "Delivery" above says\./);
  assert.doesNotMatch(git, /push \(to the target branch, or to the card's branch/);
});

test("the section is general-audience text", () => {
  assert.deepEqual(bannedHits(skill.slice(start, end)), []);
});
