#!/usr/bin/env node
//
// check-injection-budget.mjs — DX-3053.
//
// Publish-time gate: refuses a publish whose measured injection totals
// exceed an agreed ceiling. Reuses scripts/measure-injection.mjs to get the
// real numbers (R-16 / PLN-11 — extend an existing tool, never build a
// second one that re-implements hook execution).
//
// CEILINGS (AC 32513 — one named constant, carrying the deciding card id)
// -------------------------------------------------------------------------
// DX-3347 is the decision that set today's injection shape: one mantra file
// at SessionStart (startup/resume/compact only), every standing per-turn
// reminder deleted. Its own measurement (card comment 6999, reproduced here
// via scripts/measure-injection.mjs at origin/main commit ae177d0) recorded:
//   - per-turn (UserPromptSubmit, unconditional): 23B — the wall-clock line,
//     the one thing DX-3347 explicitly kept (since DX-4234 the danxbot module's
//     time stamp on prompt.submit, measured by running its pure `stamp`).
//   - session-start (SessionStart, fires at startup): 26,373B.
//     Since DX-4234 session-start measures 0B here: the event text and the restart notice are the dashboard's
//     (registry and server) text, delivered by the danxbot module with no offline bytes to count. The ceiling stays
//     at DX-3347's, so a standing session-start injection cannot come back unnoticed.
// This gate also folds in PostToolUse's unconditional per-tool-call total
// (23B, the same clock's after-each-tool-call stamp, tool.call since DX-4234) into the "per-turn"
// figure — a turn typically includes at least one tool call, so the
// ceiling should police the combined standing weight of a turn, not just
// its UserPromptSubmit half. measure-injection.mjs's own totals stay
// un-summed (AC 32510) — this combination happens only here, for the gate.
//
// Ceilings give MODEST headroom over the measured DX-3347 numbers: enough
// to absorb ordinary content growth (a skill body gaining a paragraph, the
// clock format picking up a few characters), nowhere near enough to let a
// standing per-turn mandate sneak back in unnoticed (the pre-DX-3347 shape
// measured 3,715B/turn — DX-3278 comment 6976).
//   PER_TURN_CEILING_BYTES = 200        — ~4.3x the measured 46B combined
//                                         (23B UserPromptSubmit + 23B
//                                         PostToolUse); ~18x under the
//                                         pre-DX-3347 3,715B/turn total.
//   SESSION_START_CEILING_BYTES = 32000 — ~21% over the measured 26,373B.
export const CEILING_DECISION_CARD = "DX-3347";
export const PER_TURN_CEILING_BYTES = 200;
export const SESSION_START_CEILING_BYTES = 32000;

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEASURE_SCRIPT = path.join(REPO_ROOT, "scripts", "measure-injection.mjs");

// Pure evaluator, exported so a test can feed a synthetic (deliberately
// over-budget) totals fixture and prove the check FAILS (AC 32514) without
// needing to build a real oversized hook script.
export function evaluateBudget(
  totals,
  ceilings = { perTurn: PER_TURN_CEILING_BYTES, sessionStart: SESSION_START_CEILING_BYTES }
) {
  const perTurnCombined = totals.perTurnUnconditional + totals.perToolCall;
  const failures = [];
  if (perTurnCombined > ceilings.perTurn) {
    failures.push(
      `per-turn (UserPromptSubmit ${totals.perTurnUnconditional}B + PostToolUse ${totals.perToolCall}B = ${perTurnCombined}B) exceeds the ${ceilings.perTurn}B ceiling set by ${CEILING_DECISION_CARD}`
    );
  }
  if (totals.perSession > ceilings.sessionStart) {
    failures.push(
      `session-start (${totals.perSession}B) exceeds the ${ceilings.sessionStart}B ceiling set by ${CEILING_DECISION_CARD}`
    );
  }
  return { ok: failures.length === 0, perTurnCombined, failures };
}

function measureRealTotals() {
  const out = execFileSync("node", [MEASURE_SCRIPT, "--json"], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.toString("utf8")).totals;
}

function main() {
  const args = process.argv.slice(2);
  const totalsJsonIdx = args.indexOf("--totals-json");

  // TEST-ONLY escape hatch (AC 32514): a fixture path in place of a real
  // measurement, so the ceiling-fail path is provable without an actual
  // over-budget hook script. Production/publish.sh callers never pass this.
  const totals =
    totalsJsonIdx !== -1
      ? JSON.parse(fs.readFileSync(args[totalsJsonIdx + 1], "utf8"))
      : measureRealTotals();

  const result = evaluateBudget(totals);
  if (result.ok) {
    console.log(
      `Injection budget OK — per-turn ${result.perTurnCombined}B (ceiling ${PER_TURN_CEILING_BYTES}B), session-start ${totals.perSession}B (ceiling ${SESSION_START_CEILING_BYTES}B).`
    );
    process.exit(0);
  }
  console.error("Injection budget check FAILED:");
  for (const f of result.failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
