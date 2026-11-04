import "./designated-test-container.mjs";
// The `50arms-ready` skill is the agent's own way onto the team's ready list: it loads the skill itself, by default whenever the work is 50 Arms work.
// The plugin does the join when the skill loads (hooks/register.tsx); these tests pin the skill's text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { bannedHits } from "../../scripts/check-general-audience.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, "../skills/50arms-ready/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(raw);
assert.ok(frontmatter, "the skill opens with a YAML frontmatter block");
const meta = loadYaml(frontmatter[1]);
const body = raw.slice(frontmatter[0].length);

test("the skill is named like the command, and its description says when the agent loads it on its own", () => {
  assert.equal(meta.name, "50arms-ready");
  assert.match(meta.description, /ready list/);
  assert.match(meta.description, /planning or working with 50 Arms/);
  assert.match(meta.description, /by default when unsure/);
  assert.match(meta.description, /ask the person when it is truly unclear/);
  assert.match(meta.description, /unrelated to 50 Arms/);
  assert.match(meta.description, /`off`/);
  assert.ok(meta.description.length + String(meta.when_to_use ?? "").length <= 1536);
});

test("the body leans to yes, asks when unclear, stays off for unrelated work, and says loading it joins", () => {
  const flat = body.replace(/\s+/g, " ");
  assert.match(flat, /Lean towards yes/);
  assert.match(flat, /load the skill/);
  assert.match(flat, /ask one short question/);
  assert.match(flat, /unrelated to 50 Arms/);
  assert.match(flat, /does the same as the person typing `\/50arms-ready`/);
  assert.match(flat, /argument `off`/);
});

test("nothing it shows says danx (DEC-405) or names the plugin author's own setup", () => {
  assert.doesNotMatch(raw, /danx/i);
  assert.deepEqual(bannedHits(raw), []);
});
