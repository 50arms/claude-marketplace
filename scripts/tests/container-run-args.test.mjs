import "../../danxbot/tests/designated-test-container.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { containerRunArgs } from "../lib/container-run-args.mjs";

const runner = readFileSync(new URL("../test-in-container.mjs", import.meta.url), "utf8");

// CP-2: the daemon, not the runner's exit handler, removes the container.
test("the container is started with docker run --rm", () => {
  const args = containerRunArgs("n", "img", ["a.test.mjs"]);
  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
});

// CP-2: no container exists before it is running under --rm: the archive arrives on stdin and the bootstrap unpacks it.
test("the source archive is handed over on stdin and unpacked before the entry script runs", () => {
  const args = containerRunArgs("n", "img", ["a.test.mjs", "b.test.mjs"]);
  assert.ok(args.includes("-i"));
  const script = args[args.indexOf("-c") + 1];
  assert.match(script, /^tar -x -C \/app && exec bash scripts\/test-container-entry\.sh "\$@"$/);
  assert.deepEqual(args.slice(-2), ["a.test.mjs", "b.test.mjs"]);
  assert.match(runner, /spawn\("docker", containerRunArgs\(/);
  assert.match(runner, /stdio: \["pipe"/);
  assert.match(runner, /\.stdin\.end\(archive\)/);
});

test("the runner has no create, cp or start step and no exit handler", () => {
  assert.doesNotMatch(runner, /"create"|"cp"|"start"|process\.on\("exit"|"rm", "-f"/);
});
