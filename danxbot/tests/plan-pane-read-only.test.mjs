// DX-4609 (PLAN-23 G-1): the Plan pane is for status and calls to action; every interaction with a problem is in the browser.
// Nothing under hooks/ reaches a problem's write routes or draws a control to compose an answer, a rejection or a comment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir) {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

test("no hook source calls a problem's answer, comment, solution or step route, or draws an Input", () => {
  const sources = files("hooks");
  assert.ok(sources.length > 10, "the scan covers the hooks module");
  for (const rel of sources) {
    const src = readFileSync(path.join(root, rel), "utf8");
    assert.doesNotMatch(src, /(issues|problems)\/[^'"`\s]*\b(answer|comments|solutions|steps)\b/, `${rel} reaches no write route of a problem`);
    assert.doesNotMatch(src, /\/api\/issues\/\$\{[^}]*\}\/problems/, `${rel} reads no problem's detail`);
    assert.doesNotMatch(src, /<Input\b/, `${rel} draws no text input`);
  }
});

test("the problem row is a link and nothing else: it takes no handlers", () => {
  const src = readFileSync(path.join(root, "hooks/plan/problems.tsx"), "utf8");
  assert.doesNotMatch(src, /\bhd\b|Handlers|onPress|onSubmit|<Button\b/);
});
