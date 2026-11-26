import "./designated-test-container.mjs";
// The designer refusal names one of the plugin's own agent types: the table in pacing-guard.ts must equal the agent files, so a name it gives always exists
// and runs on what the table says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agents = path.join(here, "../agents");
const guard = readFileSync(path.join(here, "../hooks/plan/pacing-guard.ts"), "utf8");
const frontmatter = (text, key) => new RegExp(`^${key}:[ \t]*(.*?)[ \t]*$`, "m").exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1])[1];

test("the own agent type table equals the agent files, and leaves out only the Haiku types", () => {
  const table = [...guard.matchAll(/\{ type: '50arms:([\w-]+)', model: '(\w+)', effort: '(\w+)' \}/g)].map(m => ({ name: m[1], model: m[2], effort: m[3] }));
  assert.ok(table.length > 0);
  for (const t of table) {
    const text = readFileSync(path.join(agents, `${t.name}.md`), "utf8");
    assert.equal(frontmatter(text, "model"), t.model);
    assert.equal(frontmatter(text, "effort"), t.effort);
  }
  const left = readdirSync(agents).filter(f => f.endsWith(".md") && !table.some(t => `${t.name}.md` === f));
  assert.deepEqual(left.sort(), ["worker-haiku-high.md", "worker-haiku-low.md"]);
});
