// Smoke test for scripts/measure-injection.mjs (DX-3053).
//
// Full ceiling-gate testing (AC 32514 — "a test proves the check FAILS on
// a deliberately over-budget fixture") is NOT here: DX-3053's ceiling
// constant depends on the cadence-model decision on DX-3052 (problem 300,
// open, no decision recorded as of this commit), and the card's own text
// says "do not invent one here." This test instead proves the MEASUREMENT
// harness itself is trustworthy — the one piece AC 32507-32511 asked for
// and that does not depend on the unanswered decision:
//   1. It reproduces DX-3049's manual baseline exactly, at the exact
//      commit those figures were measured against (git archive of
//      4b8b0a9, where base=0.4.16 / danxbot=0.7.18 / dev=0.4.3 /
//      human-collaboration=0.4.18 / investigate=0.3.15 all hold
//      simultaneously — verified via `git show <rev>:plugin.json` before
//      writing this test).
//   2. It runs clean (exit 0, well-formed JSON, the three totals present
//      and never summed together) against the CURRENT tree, proving the
//      harness itself does not bit-rot as plugin content moves.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "measure-injection.mjs");
const MANTRA_SCRIPT = path.join(REPO_ROOT, "danxbot", "scripts", "mantra.sh");
const MANTRA_PLUGIN_ROOT = path.join(REPO_ROOT, "danxbot");

function run() {
  const out = execFileSync("node", [SCRIPT, "--json"], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out.toString("utf8"));
}

test("measure-injection reports the three cadence totals, never summed together", () => {
  const { totals, rows } = run();
  assert.equal(typeof totals.perTurnUnconditional, "number");
  assert.equal(typeof totals.perSession, "number");
  assert.equal(typeof totals.perToolCall, "number");
  assert.ok(rows.length > 0, "expected at least one measured hook row");
  // Every row is byte-accounted or explicitly flagged as an error — never
  // silently absent (AC 32508's "never mistaken for a hook that emits
  // nothing" applies to the harness's OWN reporting too).
  for (const r of rows) {
    assert.equal(typeof r.bytes, "number");
  }
});

test("every UserPromptSubmit hook is measured on both prompts and classified", () => {
  const { rows } = run();
  const promptRows = rows.filter((r) => r.event === "UserPromptSubmit");
  assert.ok(promptRows.length > 0, "expected inject-time.sh to be measured");
  for (const r of promptRows) {
    assert.ok(["conditional", "unconditional"].includes(r.kind), `${r.command} is unclassified`);
    assert.equal(typeof r.triggerBytes, "number");
  }
});

test("reproduces the DX-3049 baseline (4438 / 46369) at the exact commit those figures were measured against", () => {
  // Deliberately does NOT assert the per-tool-call (32) figure — measured
  // and could not be reproduced exactly (23 with a fresh per-invocation
  // session id, matching inject-time.sh's documented fixed-width
  // first-fire format; see DX-3053 report for the discrepancy). That
  // figure is 9 bytes on one minor always-tiny hook and does not gate
  // anything DX-3053 builds.
  // mktemp -d (not node's os.tmpdir()) so the resulting path is already
  // POSIX-shaped for the `bash -c` calls below — on this Windows/Git-Bash
  // machine, os.tmpdir() returns a `C:\...` path that bash's own `tar -C`
  // cannot resolve.
  const archiveDir = execFileSync("bash", ["-c", "mktemp -d"]).toString("utf8").trim();

  execFileSync("bash", ["-c", `git archive 4b8b0a9 | tar -x -C '${archiveDir}'`], {
    cwd: REPO_ROOT,
  });
  execFileSync("bash", ["-c", `cp '${SCRIPT.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1")}' '${archiveDir}/scripts/measure-injection.mjs'`]);

  const out = execFileSync("bash", ["-c", `cd '${archiveDir}' && node scripts/measure-injection.mjs --json`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const { totals } = JSON.parse(out.toString("utf8"));

  assert.equal(totals.perTurnUnconditional, 4438);
  assert.equal(totals.perSession, 46369);
});

test("AC 32508: an unset CLAUDE_PLUGIN_ROOT under-reports a real hook — the harness must always set it", () => {
  // mantra.sh (DX-3347) references ${CLAUDE_PLUGIN_ROOT} directly under
  // `set -euo pipefail`. Run it two ways: with the env var absent (as a
  // naive harness would), and with it set the way runCommand() in
  // measure-injection.mjs always does. The unset run must silently emit
  // ZERO stdout bytes — proving that without this harness discipline, a
  // real hook reads as "emits nothing" rather than failing loudly.
  //
  // DX-3275: mantra.sh's output size now depends on plan-connection state
  // (unconnected -> the short nudge, connected -> the full mantra), and the
  // harness's own freshSessionId() is by construction never connected — so
  // its measured row is the nudge size, not the mantra size. The nudge is
  // still nonzero, which is exactly what this AC needs proof of (CLAUDE_PLUGIN_ROOT
  // being set is what stands between 0 bytes and SOME bytes); the "does the full
  // mantra actually print" behavior is covered separately by
  // danxbot/tests/mantra.test.mjs's "connected" case.
  const stdin = JSON.stringify({ session_id: "cpb-test-unset", source: "startup" });

  const envWithoutRoot = { ...process.env };
  delete envWithoutRoot.CLAUDE_PLUGIN_ROOT;

  let unsetBytes;
  try {
    const out = execFileSync("bash", [MANTRA_SCRIPT], {
      input: stdin,
      env: envWithoutRoot,
      cwd: REPO_ROOT,
    });
    unsetBytes = out.length;
  } catch (err) {
    // A non-zero exit is also acceptable proof of the failure mode, as
    // long as stdout itself carried nothing.
    unsetBytes = err.stdout ? err.stdout.length : 0;
  }
  assert.equal(unsetBytes, 0, "expected an unset CLAUDE_PLUGIN_ROOT to under-report to 0 bytes");

  const unconnectedBytes = execFileSync("bash", [MANTRA_SCRIPT], {
    input: stdin,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: MANTRA_PLUGIN_ROOT },
    cwd: REPO_ROOT,
  }).length;
  assert.ok(
    unconnectedBytes > 0,
    `expected the plan-workflow nudge's nonzero byte count with CLAUDE_PLUGIN_ROOT set, got ${unconnectedBytes}`,
  );

  // And the harness itself (which always sets CLAUDE_PLUGIN_ROOT, but never
  // connects its fresh per-row session id to a plan) must report that same
  // nonzero nudge figure for this hook, in its own output — never 0.
  const { rows } = run();
  const mantraRow = rows.find((r) => r.command.includes("mantra.sh"));
  assert.ok(mantraRow, "expected mantra.sh to be measured");
  assert.equal(
    mantraRow.bytes,
    unconnectedBytes,
    "the harness must report mantra.sh's real (unconnected/nudge) byte count, not 0",
  );
});

test("perSession includes a SessionStart hook whose matcher still fires at startup (DX-3347's mantra.sh)", () => {
  // Regression test for the bug this card's extension fixed: mantra.sh has
  // matcher="startup|resume|compact" — a real matcher, but one that still
  // fires at ordinary session start. summarize()'s old "no matcher" test
  // silently excluded it from perSession (22,664B measured instead of the
  // real 26,373B DX-3347 itself reported).
  const { rows, totals } = run();
  const mantraRow = rows.find((r) => r.event === "SessionStart" && r.command.includes("mantra.sh"));
  assert.ok(mantraRow, "expected mantra.sh to be measured under SessionStart");
  assert.ok(mantraRow.matcher, "expected mantra.sh to carry a real matcher (not null)");

  const noMatcherSum = rows
    .filter((r) => r.event === "SessionStart" && !r.matcher)
    .reduce((sum, r) => sum + r.bytes, 0);

  assert.ok(
    totals.perSession >= noMatcherSum + mantraRow.bytes,
    "perSession must include mantra.sh's bytes, not just the no-matcher group"
  );
});
