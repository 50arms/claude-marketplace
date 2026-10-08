// scripts/check-injection-budget.mjs — publish-time injection budget gate.
// DX-3053 AC 32512-32514.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-injection-budget.mjs");

const {
  evaluateBudget,
  PER_TURN_CEILING_BYTES,
  CEILING_DECISION_CARD,
} = await import(pathToFileURL(SCRIPT).href);

function fixturePath(totals) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "injection-budget-test-"));
  const file = path.join(dir, "totals.json");
  fs.writeFileSync(file, JSON.stringify(totals));
  return file;
}

function runCli(totals) {
  const file = fixturePath(totals);
  try {
    const out = execFileSync("node", [SCRIPT, "--totals-json", file], { encoding: "utf8" });
    return { code: 0, stdout: out };
  } catch (err) {
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

test("AC 32513: the ceiling is one named constant carrying the deciding card id", () => {
  assert.equal(typeof PER_TURN_CEILING_BYTES, "number");
  assert.equal(CEILING_DECISION_CARD, "DX-3347");
});

test("evaluateBudget passes on today's real measured shape (23B per prompt, 23B per tool call)", () => {
  const result = evaluateBudget({ perTurnUnconditional: 23, perToolCall: 23 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("AC 32514: evaluateBudget FAILS on a deliberately over-budget per-turn fixture", () => {
  // The pre-DX-3347 per-turn shape (3,715B — DX-3278 comment 6976) is
  // exactly the regression this gate exists to catch.
  const result = evaluateBudget({ perTurnUnconditional: 3692, perToolCall: 23 });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /per-turn/);
  assert.match(result.failures[0], /DX-3347/);
});

test("AC 32514: the CLI itself exits non-zero on the over-budget fixture, not only the pure function", () => {
  const result = runCli({ perTurnUnconditional: 5000, perToolCall: 23 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Injection budget check FAILED/);
  assert.match(result.stderr, /per-turn/);
});

test("the CLI exits 0 on an in-budget fixture", () => {
  const result = runCli({ perTurnUnconditional: 23, perToolCall: 23 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Injection budget OK/);
});

test("the CLI's default (no --totals-json) path measures the REAL current tree and passes today", () => {
  const out = execFileSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(out, /Injection budget OK/);
});
