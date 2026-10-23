import "../../danxbot/tests/designated-test-container.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { containerCreateArgs } from "../lib/container-create-args.mjs";

// CP-2: the daemon, not the runner's exit handler, removes the container.
test("docker create carries --rm", () => {
  const args = containerCreateArgs("n", "img", ["a.test.mjs"]);
  assert.equal(args[0], "create");
  assert.ok(args.includes("--rm"));
  assert.deepEqual(args.slice(-3), ["bash", "scripts/test-container-entry.sh", "a.test.mjs"]);
});

test("the runner builds its create call from containerCreateArgs and keeps the exit-handler removal for a never-started container", () => {
  const src = readFileSync(new URL("../test-in-container.mjs", import.meta.url), "utf8");
  assert.match(src, /docker\(containerCreateArgs\(/);
  assert.match(src, /"rm", "-f", createdContainer/);
});
