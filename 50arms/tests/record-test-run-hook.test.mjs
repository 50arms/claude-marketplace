import "./designated-test-container.mjs";
// CP-57: the hook half of the test-run recorder. The kit cannot run a Bash result through the module end to end here, so the pure post builder is
// checked directly and the seating (the handler that posts) is pinned by source, as own-server-check-scan does for tool.check.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../hooks/register.tsx", import.meta.url), "utf8");
const pure = readFileSync(new URL("../hooks/context/test-run.ts", import.meta.url), "utf8");

test("the tool handler posts a Bash result's test-run record through api() (the session's own server, background)", () => {
  assert.match(source, /if \(e\.tool === 'Bash'\) detach\(\$, 'danxbot test-run record', postTestRun\(\$, r\)\)/);
  assert.match(source, /api\(\$, 'POST', post\.path, \{ body: post\.body \}\)/);
});

test("the marker the hook reads is the one the script prints", () => {
  const marker = /RECORD_MARKER = "(\w+)"/.exec(readFileSync(new URL("../scripts/lib/test-run.mjs", import.meta.url), "utf8"))[1];
  assert.match(pure, new RegExp(`RECORD_MARKER = '${marker}'`));
});
