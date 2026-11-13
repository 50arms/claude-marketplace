import "./designated-test-container.mjs";
// DX-5899 (PLAN-44 G-7), CP-109 (DEC-832) — every `50arms:worker-*` agent is the same worker at a different grade: the model and effort
// differ in its frontmatter, and its opening paragraph frames the work for that grade (the haiku workers' takes a well-specified task and
// follows the brief exactly). Everything after that opening (the profile-brief line, the no-window rule) is one text, so it holds for every
// grade only while it is the same in each. The wording itself is the agent text's own, reviewed with it, never pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../agents");
const agents = readdirSync(agentsDir)
  .filter((name) => name.startsWith("worker-") && name.endsWith(".md"))
  .map((name) => ({ name, text: readFileSync(path.join(agentsDir, name), "utf8") }));

// the shared body: everything after the closing `---` of the frontmatter, less its opening paragraph (the grade's own framing)
function sharedBodyOf(name, text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name} has no frontmatter block`);
  const paragraphs = m[1].replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  assert.ok(paragraphs.length > 1, `${name} has nothing after its opening paragraph`);
  return paragraphs.slice(1).join("\n\n");
}

test("there are worker agents to check", () => {
  assert.ok(agents.length >= 7, agents.map((a) => a.name).join(", "));
});

test("every worker agent has the same body below its frontmatter, after its opening paragraph", () => {
  const [first, ...rest] = agents.map(({ name, text }) => ({ name, body: sharedBodyOf(name, text) }));
  for (const { name, body } of rest) assert.equal(body, first.body, `${name}'s body differs from ${first.name}'s`);
});
