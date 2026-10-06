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

test("a missing control key stops the session instead of guessing false", () => {
  assert.match(delivery, /missing from the reply[^.]*stop and report/);
  assert.match(delivery, /Never guess `false`/);
});

test("required false keeps the push to the target branch", () => {
  assert.match(delivery, /\*\*`required` is `false`:\*\* commit and push to the target branch/);
});

test("required true: the gh check comes first, names what to run, and stops", () => {
  assert.ok(required.includes("never pushed to"));
  const first = step(1);
  assert.ok(first.includes("`gh --version`") && first.includes("`gh auth status`"), first);
  assert.ok(first.includes("`gh auth login`"), first);
  assert.match(first, /Then stop\./);
  assert.match(first, /Never fall back to pushing the target branch/);
});

test("required true: branch off the target, push the branch, open the PR, write the link", () => {
  const expected = [
    [2, "origin/<target branch>"],
    [2, "never the target branch itself"],
    [2, "git push -u origin <branch>"],
    [3, "gh pr create --base <target branch> --head <branch>"],
    [3, "Card: <link to the card"],
    [4, "PATCH /api/issues/<id>/edit"],
    [4, '"pull_request_url"'],
  ];
  for (const [n, text] of expected) assert.ok(step(n).includes(text), `step ${n} lacks ${text}`);
});

test("done_on opened completes the card; merged leaves it in progress and says so", () => {
  const last = step(5);
  assert.match(last, /`opened`: transition `complete`/);
  assert.match(last, /`merged`: leave the card in progress with its pull request link/);
  assert.match(last, /completes when the pull request merges\. Do not transition `complete`/);
});

test("the flow's landing step, the caller table and the Git section point at Delivery", () => {
  const all = flat(skill);
  assert.match(all, /commits and pushes to main, or opens a pull request when the card's controls require one \("Delivery" below\)/);
  assert.match(all, /push to main \(or open a pull request when "Delivery" below says so\)/);
  assert.match(all, /push \(to the target branch, or to the card's branch when "Delivery" says a pull request is required\)/);
});

test("the section is general-audience text", () => {
  assert.deepEqual(bannedHits(skill.slice(start, end)), []);
});
