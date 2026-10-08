// scripts/measure-injection.mjs (DX-3053): it measures each hooks module's time stamp (DX-4234), the only standing text a
// module hands the model, against the CURRENT tree, so the harness cannot bit-rot as plugin content moves. The ceiling gate
// is scripts/tests/check-injection-budget.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "measure-injection.mjs");

function run() {
  const out = execFileSync("node", [SCRIPT, "--json"], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.toString("utf8"));
}

test("measure-injection reports the two cadence totals, never summed together", () => {
  const { totals, rows } = run();
  assert.deepEqual(Object.keys(totals).sort(), ["perToolCall", "perTurnUnconditional"]);
  assert.ok(rows.length > 0, "expected at least one measured hook row");
  // Every row is byte-accounted or explicitly flagged as an error — never
  // silently absent (AC 32508's "never mistaken for a hook that emits
  // nothing" applies to the harness's OWN reporting too).
  for (const r of rows) {
    assert.equal(typeof r.bytes, "number");
  }
});

test("the function hooks' time stamp is measured on prompt.submit and tool.call, and counted into the per-turn and per-tool-call totals (DX-4234)", () => {
  const { rows, totals } = run();
  const prompt = rows.filter((r) => r.event === "prompt.submit");
  const tool = rows.filter((r) => r.event === "tool.call");
  assert.equal(prompt.length, 1, "expected the danxbot module's prompt.submit stamp to be measured");
  assert.equal(tool.length, 1, "expected the danxbot module's tool.call stamp to be measured");
  for (const r of [...prompt, ...tool]) {
    assert.equal(r.error, null);
    // the widest stamp, the first (it carries the date): `MM/DD/YYYY HH:MM:SS +HH:MM +0` and a newline
    assert.equal(r.bytes, "09/28/2026 01:12:03 -06:00 +0\n".length);
  }
  assert.equal(totals.perTurnUnconditional, prompt[0].bytes);
  assert.equal(totals.perToolCall, tool[0].bytes);
});

test("a plugin with modules and no stamp.ts is an error row, never zero bytes (DX-4234)", () => {
  const repo = fakeRepo({ modules: ["./register.tsx"] });
  try {
    const { rows } = JSON.parse(execFileSync("node", [path.join(repo, "scripts", "measure-injection.mjs"), "--json"], { cwd: repo }).toString("utf8"));
    assert.fail(`expected a non-zero exit, got rows ${JSON.stringify(rows)}`);
  } catch (err) {
    const { rows } = JSON.parse(err.stdout.toString("utf8"));
    assert.ok(rows.length > 0 && rows.every((r) => r.error && /stamp.ts is missing/.test(r.error)), JSON.stringify(rows));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A throwaway marketplace of one plugin with the given hooks.json, with this checkout's measure-injection.mjs beside it: the
// harness reads its repo root from its own location.
function fakeRepo(hooksJson) {
  const repo = mkdtempSync(path.join(tmpdir(), "measure-injection-repo-"));
  mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "p", source: "./p" }] }));
  mkdirSync(path.join(repo, "p", "hooks"), { recursive: true });
  writeFileSync(path.join(repo, "p", "hooks", "hooks.json"), JSON.stringify(hooksJson));
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(repo, "scripts", "measure-injection.mjs"));
  return repo;
}
