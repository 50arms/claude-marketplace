// DX-4560 — a session building a card in a repo that needs review (a team's own repo) must end
// with an open pull request, never a push to the target branch, while danxbot's own boards keep
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
const COMMANDS_THAT_LEAVE_THE_MACHINE = ["git push", "gh pr create", "gh pr view"];

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

test("required false keeps the push to the target branch", () => {
  assert.match(delivery, /\*\*`required` is `false`:\*\* commit and push to the target branch/);
});

test("required true: step 1 is the gh check: gh auth token, an action problem, then stop", () => {
  assert.ok(required.includes("never pushed to"));
  const first = step(1);
  assert.ok(first.includes("`gh --version`") && first.includes("`gh auth token`"), first);
  assert.ok(first.includes("`gh auth login`"), first);
  assert.match(first, /open an `action` problem/);
  assert.match(first, /Then stop\./);
  assert.match(first, /Never fall back to pushing the target branch/);
  // `gh auth status` may appear only as the command the step tells the session not to use
  assert.match(first, /`gh auth status`[^.]*do not use it/);
});

test("required true: no command that leaves the machine appears before the gh check", () => {
  const check = required.indexOf("`gh auth token`");
  assert.ok(check > -1);
  for (const cmd of COMMANDS_THAT_LEAVE_THE_MACHINE) {
    assert.ok(required.indexOf(cmd) > check, `${cmd} must come after the gh check`);
    assert.ok(!step(1).includes(cmd), `step 1 must not run ${cmd}`);
  }
});

test("required true: branch off the target, push the branch, reuse or open the PR, write the link", () => {
  const expected = [
    [2, "origin/<target branch>"],
    [2, "never the target branch itself"],
    [2, "git push -u origin <branch>"],
    [3, "gh pr view <branch> --json url,state"],
    [3, "gh pr create --base <target branch> --head <branch>"],
    [3, "--body-file"],
    [3, "<dashboard>/plans/<plan id>/cards/<card id>"],
    [3, "<dashboard>/cards/<card id>"],
    [4, "PATCH /api/issues/<id>/edit"],
    [4, '"pull_request_url"'],
  ];
  for (const [n, text] of expected) assert.ok(step(n).includes(text), `step ${n} lacks ${text}`);
  assert.ok(step(3).indexOf("gh pr view") < step(3).indexOf("gh pr create"), "reuse is checked before creating");
});

test("done_on opened completes the card and writes the retro", () => {
  const opened = step(5).slice(step(5).indexOf("`opened`"), step(5).indexOf("`merged`"));
  assert.match(opened, /transition `complete`/);
  assert.match(opened, /retro/);
});

test("done_on merged never completes, releases the claim, and says the person completes it", () => {
  const merged = step(5).slice(step(5).indexOf("`merged`"));
  assert.match(merged, /^`merged`: do not transition `complete`/);
  assert.match(merged, /`rollback_pickup`/);
  assert.match(merged, /until the pull request merges/);
  assert.match(merged, /the person completes it then/);
  assert.doesNotMatch(merged, /completes when the pull request merges/);
});

test("the caller table and flow step 6 name the target branch, never main, and point at Delivery", () => {
  const row = flat(skill.split("\n").find((line) => line.startsWith("| Merge + end")));
  assert.match(row, /push to the target branch \(or open a pull request when "Delivery" below says so\)/);
  assert.doesNotMatch(row, /\bmain\b/);
  const step6 = flat(skill.slice(skill.indexOf("\n6. "), skill.indexOf("## Gates")));
  assert.match(step6, /pushes to the target branch, or opens a pull request when the card's controls require one \("Delivery" below\)/);
  assert.doesNotMatch(step6, /origin\/main|to main/);
  assert.match(flat(skill), /push \(to the target branch, or to the card's branch when "Delivery" says a pull request is required\)/);
});

test("the section is general-audience text", () => {
  assert.deepEqual(bannedHits(skill.slice(start, end)), []);
});
