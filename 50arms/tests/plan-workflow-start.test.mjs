import "./designated-test-container.mjs";
// DX-5554 - plan-workflow's Start section: a session signs in, takes its team agent's identity from the reply, proposes an agent itself when none
// is free (`agent_needed`, through 50arms_api, without asking), tells the person the limit (`agent_limit_reached`), holds a stand-alone card with
// `session_connect`, and titles itself by what it holds. No skill of the plugin tells a session to choose its own name any more.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.join(here, "../skills");
const flat = (text) => text.replace(/\r\n/g, "\n").replace(/\s+/g, " ");
const planWorkflow = readFileSync(path.join(skillsDir, "plan-workflow/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
const startAt = planWorkflow.indexOf("## Start (every new, resumed or compacted session)");
assert.ok(startAt !== -1, "plan-workflow has its Start section");
const startEnd = planWorkflow.indexOf("\n## ", startAt + 1);
const start = flat(planWorkflow.slice(startAt, startEnd));

test("Start signs in first, approval included", () => {
  assert.match(start, /1\. Sign in: `session_connect`/);
  assert.match(start, /`approval_required` \(or `approval_pending`\)/);
});

test("Start takes the session's identity from the reply's agent", () => {
  assert.match(start, /`agent` and `agentInstruction`/);
});

test("agent_needed: the session proposes an agent through 50arms_api, with the routes and fields", () => {
  assert.match(start, /`agent_needed`/);
  assert.match(start, /`POST \/api\/team\/agent-proposals`/);
  assert.match(start, /`\{name, bio\}`/);
  assert.match(start, /`POST \/api\/team\/agent-proposals\/<public_id>\/avatar`/);
  assert.match(start, /`body_file`/);
  assert.match(start, /svg/);
  assert.match(start, /`session_connect` again/);
  // DX-6157: Create signs the session in and connects it, so taking them needs no connect (a naming or role step makes its own call)
  assert.match(start, /Create, which signs you in[\s\S]*Taking them needs no `session_connect`/);
  // the deleted MCP tool (DX-5724) is never named
  assert.doesNotMatch(planWorkflow, /agent_propose/);
});

test("agent_limit_reached: the session tells the person the limit and who can raise it", () => {
  assert.match(start, /`agent_limit_reached`/);
  for (const field of ["held", "limit", "raised_by"]) assert.ok(start.includes("`" + field + "`"), field);
});

test("a stand-alone card and a plan are both held with session_connect, named by `target`", () => {
  assert.match(start, /`session_connect\(\{target: "<card id>"\}\)`/);
  assert.match(start, /`session_connect\(\{target: "PLAN-n"\}\)`/);
  assert.match(start, /`card_on_plan`/);
});

test("the session title follows what it holds; the plan-less reply and a plan connect name it differently", () => {
  assert.match(start, /`\{Name\}: PLAN-NNN \{short title\}`/);
  assert.match(start, /`\{Name\}: \{CARD-ID\} \{card title\}`/);
  assert.match(start, /`title`.*`titleInstruction`/);
  assert.match(start, /`naming`/);
});

test("no skill of the plugin tells a session to pick its own name", () => {
  for (const skill of readdirSync(skillsDir)) {
    const text = flat(readFileSync(path.join(skillsDir, skill, "SKILL.md"), "utf8"));
    assert.doesNotMatch(text, /given name|free name|your own (short )?name|choose a name for yourself/i, `${skill}/SKILL.md`);
  }
});

// CP-61 / DX-6733: no approval polling, no title re-connect, and the orientation is the start packet read once
test("approval: the session ends its turn and calls session_connect once after the plugin's wake, never in a loop", () => {
  assert.match(start, /then end your turn: the plugin wakes you when they decide, and you call `session_connect` once then, never in a loop while you wait/);
  assert.doesNotMatch(start, /once they approve call `session_connect` again/);
});

test("the rename needs no second session_connect: the heartbeat carries the title", () => {
  assert.match(start, /A rename needs no second `session_connect`: the heartbeat carries the title to the dashboard/);
  assert.doesNotMatch(start, /connect again with that `title`/);
});

test("orientation is the start packet, read whole in one Read with allow_large, not a batch of card and note reads", () => {
  assert.match(start, /5\. Orient from your start packet: the connect reply names its file, and the plugin names the same file at a session start and after a compaction\. Read it whole, in ONE `Read` call with `allow_large: true` and no offset\./);
  assert.match(start, /the plan's in-flight cards with each newest agent note, the card you hold and your running sub-agents/);
  assert.doesNotMatch(start, /one batch read of its In-Progress/);
});
