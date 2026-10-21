import "../../danxbot/tests/designated-test-container.mjs";
// DX-5648: the archive writer that streams the checkout into the test container. A wrong header would hand the container a broken or
// root-owned tree, so the archive is read back by the container's own GNU tar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildUstar, splitUstarPath } from "../lib/ustar.mjs";

test("DX-5648: a short path is one name; a long one splits at a slash; an unsplittable one throws", () => {
  assert.deepEqual(splitUstarPath("a/b.txt"), { prefix: "", name: "a/b.txt" });
  const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
  assert.deepEqual(splitUstarPath(long), { prefix: "d".repeat(60), name: `${"e".repeat(60)}/file.txt` });
  assert.throws(() => splitUstarPath("x".repeat(120)), /cannot be archived/);
});

test("DX-5648: tar reads the archive back: contents, modes, owner and parent directories", () => {
  const archive = buildUstar(
    [
      { path: "danxbot/tests/a.txt", mode: 0o644, content: Buffer.from("hello\n"), mtime: 1_700_000_000 },
      { path: "scripts/run.sh", mode: 0o755, content: Buffer.from("#!/bin/sh\n"), mtime: 1_700_000_000 },
    ],
    { uid: 1000, gid: 1000 },
  );
  const listing = spawnSync("tar", ["-tvf", "-", "--numeric-owner"], { input: archive, encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const rows = listing.stdout.trim().split("\n");
  assert.ok(rows.some((r) => /^-rw-r--r-- 1000\/1000 +6 .* danxbot\/tests\/a\.txt$/.test(r)), listing.stdout);
  assert.ok(rows.some((r) => /^-rwxr-xr-x 1000\/1000 +10 .* scripts\/run\.sh$/.test(r)), listing.stdout);
  assert.ok(rows.some((r) => /^drwxr-xr-x 1000\/1000 .* danxbot\/tests\/$/.test(r)), listing.stdout);
  const content = spawnSync("tar", ["-xOf", "-", "danxbot/tests/a.txt"], { input: archive, encoding: "utf8" });
  assert.equal(content.stdout, "hello\n");
});
