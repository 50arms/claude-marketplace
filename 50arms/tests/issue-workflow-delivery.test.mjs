import "./designated-test-container.mjs";
// The Delivery section stays general-audience text (DX-4551). The section's wording is deliberately not pinned
// by any test: tests never assert prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannedHits } from "../../scripts/check-general-audience.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(path.join(here, "../skills/issue-workflow/SKILL.md"), "utf8");

const start = skill.indexOf("## Delivery");
const end = skill.indexOf("\n## ", start + 1);
assert.ok(start > -1 && end > start, "the skill has a `## Delivery` section followed by another section");

test("the section is general-audience text", () => {
  assert.deepEqual(bannedHits(skill.slice(start, end)), []);
});
