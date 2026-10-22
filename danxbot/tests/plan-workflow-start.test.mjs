import "./designated-test-container.mjs";
// DX-5554 - plan-workflow's Start section: a session signs in, takes its team agent's identity from the reply, proposes an agent itself when none
// is free (`agent_needed`, through danxbot_api, without asking), tells the person the limit (`agent_limit_reached`), holds a stand-alone card with
// `card_connect`, and titles itself by what it holds. No skill of the plugin tells a session to choose its own name any more.

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
  assert.match(start, /1\. Sign in: `plan_connect`/);
  assert.match(start, /`approval_required` \(or `approval_pending`\)/);
});

test("Start takes the session's identity from the reply's agent, never a name of its own", () => {
  assert.match(start, /the reply's `agent` and `agentInstruction` say which/);
  assert.match(start, /never choose a name yourself/);
});

test("agent_needed: the session proposes an agent through danxbot_api at once, with the exact routes and bodies, then claims it when woken", () => {
  assert.match(start, /`agent_needed` → propose one at once, without asking in chat/);
  assert.match(start, /`danxbot_api` `POST \/api\/team\/agent-proposals` with `\{name, bio\}`/);
  assert.match(start, /answers `\{public_id, url, expires_at\}`/);
  assert.match(start, /`POST \/api\/team\/agent-proposals\/<public_id>\/avatar` with `body_file` set to its absolute path/);
  assert.match(start, /you are woken with an event saying the agent was created\. Then call `plan_connect` again to take it/);
  // the deleted MCP tool (DX-5724) is never named
  assert.doesNotMatch(planWorkflow, /agent_propose/);
});

test("agent_limit_reached: the session tells the person the limit and who can raise it", () => {
  assert.match(start, /`agent_limit_reached` → tell the person the limit the reply names \(`held` of `limit`, and who can raise it, `raised_by`\)/);
  assert.match(start, /Until an agent is held, every other dashboard call answers that same state: do no other dashboard work/);
});

test("a stand-alone card is held with card_connect, a plan with plan_connect, never both", () => {
  assert.match(start, /`card_connect\(\{card_id\}\)` instead; a card on a plan is refused `card_on_plan`/);
  assert.match(start, /A session holds a plan or a card, never both/);
});

test("the session title follows what it holds", () => {
  assert.match(start, /on a plan `\{Name\}: PLAN-NNN \{short title\}`, on a card `\{Name\}: \{CARD-ID\} \{card title\}`, on neither `\{Name\}`/);
  assert.match(start, /`\{Name\}` being your agent's name/);
});

test("no skill of the plugin tells a session to pick its own name", () => {
  for (const skill of readdirSync(skillsDir)) {
    const text = flat(readFileSync(path.join(skillsDir, skill, "SKILL.md"), "utf8"));
    assert.doesNotMatch(text, /given name|free name|your own (short )?name|choose a name for yourself/i, `${skill}/SKILL.md`);
  }
});
