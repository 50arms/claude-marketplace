// DX-4415 (R-1): what the pane layout deleted stays deleted: no dead export, no dual path, no test importing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const sources = [...walk(join(root, "hooks")), ...walk(join(root, "types"))].filter((f) => /\.(tsx?|mjs)$/.test(f));
const tests = walk(join(root, "tests")).filter((f) => /plan-.*\.(tsx|mjs)$/.test(f) && !/plan-pane-(removed|layout).test/.test(f));
const read = (f) => readFileSync(f, "utf8");

test("the deleted pane code has no symbol left in hooks/ or types/", () => {
  for (const f of sources) {
    const text = read(f);
    for (const gone of ["cappedInProgressNote", "updatedText", "InProgressRow", "hd.refresh", "refresh: () =>", "'Refresh'", "Danxbot plan"]) {
      assert.ok(!text.includes(gone), `${f} still has ${gone}`);
    }
  }
});

test("no plan test imports or presses what was deleted", () => {
  for (const f of tests) {
    const text = read(f);
    for (const gone of ["cappedInProgressNote", "updatedText", "key: 'refresh'", "noAgent"]) {
      assert.ok(!text.includes(gone), `${f} still has ${gone}`);
    }
  }
});

test("age and CARD_TITLE_MAX stay only because the problem cards use them", () => {
  const problems = read(join(root, "hooks/plan/problems.tsx"));
  assert.match(problems, /\bage\(/);
  assert.match(problems, /CARD_TITLE_MAX/);
  const pane = read(join(root, "hooks/plan/pane.tsx"));
  assert.doesNotMatch(pane, /\bage\b|CARD_TITLE_MAX/);
});
