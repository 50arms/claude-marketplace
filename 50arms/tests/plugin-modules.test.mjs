import "./designated-test-container.mjs";
// The engine's own validator accepts the plugin. The module's own behaviour is tested by `claude plugin test 50arms` (tests/*.test.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `claude` is not on PATH on every machine; CLAUDE_BIN names it (publish.sh reads the same variable).
// No CLI is a failure, never a skip: a validate nobody ran proves nothing.
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

test("DX-4232: claude plugin validate 50 Arms exits 0", () => {
  const found = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" });
  assert.equal(found.status, 0, `no claude CLI found as "${CLAUDE}": set CLAUDE_BIN to the claude executable (${found.error?.message ?? found.stderr})`);
  const r = spawnSync(CLAUDE, ["plugin", "validate", "50arms"], { cwd: path.dirname(PLUGIN), encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
