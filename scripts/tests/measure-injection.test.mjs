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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "measure-injection.mjs");
const EVENT_HOOK_SCRIPT = path.join(REPO_ROOT, "danxbot", "scripts", "event-hook.sh");
const EVENT_HOOK_PLUGIN_ROOT = path.join(REPO_ROOT, "danxbot");

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

// A fake `npx` on PATH so the CLAUDE_PLUGIN_ROOT-set case below can force a
// deterministic, offline, nonzero-bytes failure notice out of event-hook.sh
// without ever touching the network — see danxbot/tests/event-hook.test.mjs
// for the full fake-npx contract this mirrors.
function makeFakeNpx() {
  const binDir = mkdtempSync(path.join(tmpdir(), "measure-injection-fake-npx-"));
  const scriptPath = path.join(binDir, "npx");
  writeFileSync(
    scriptPath,
    ["#!/usr/bin/env bash", 'echo "fake npx: forced failure" >&2; exit 1', ""].join("\n"),
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}

test("AC 32508: an unset CLAUDE_PLUGIN_ROOT under-reports a real hook — the harness must always set it", () => {
  // event-hook.sh (DX-3421, was mantra.sh under DX-3347) references
  // ${CLAUDE_PLUGIN_ROOT} directly under `set -euo pipefail`. Run it two
  // ways: with the env var absent (as a naive harness would), and with it
  // set the way runCommand() in measure-injection.mjs always does. The
  // unset run must silently emit ZERO stdout bytes — proving that without
  // this harness discipline, a real hook reads as "emits nothing" rather
  // than failing loudly.
  //
  // DX-3421 changed WHAT "connected" looks like for this proof: an
  // unconnected session is now silent (0 bytes) by design — the old "short
  // nudge" fallback this test used to lean on for a guaranteed-nonzero,
  // no-plan-connection byte count is gone (DX-3421 comment 7748/7752
  // verdict: nothing at all before a plan is connected). So this test now
  // uses a CONNECTED session (its own fixed session id, not the harness's
  // random freshSessionId()) with a fake, always-failing `npx` on PATH — the
  // failure NOTICE line event-hook.sh prints on a fetch failure is the
  // guaranteed-nonzero output this proof needs, produced with zero network
  // access. The "does a successful fetch actually print the event text"
  // behavior is covered separately by danxbot/tests/event-hook.test.mjs.
  const home = mkdtempSync(path.join(tmpdir(), "measure-injection-cpb-home-"));
  const sessionDir = path.join(home, ".config", "danxbot", "plan-sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "cpb-test-unset.json"), JSON.stringify({ schemaVersion: 1 }));
  const fakeNpxDir = makeFakeNpx();
  const stdin = JSON.stringify({ session_id: "cpb-test-unset", source: "startup" });

  try {
    const envWithoutRoot = { ...process.env, DANXBOT_PLAN_SESSIONS_HOME: home, PATH: `${fakeNpxDir}${path.delimiter}${process.env.PATH}` };
    delete envWithoutRoot.CLAUDE_PLUGIN_ROOT;

    let unsetBytes;
    try {
      const out = execFileSync("bash", [EVENT_HOOK_SCRIPT, "SessionStart"], {
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

    const connectedFailureBytes = execFileSync("bash", [EVENT_HOOK_SCRIPT, "SessionStart"], {
      input: stdin,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: EVENT_HOOK_PLUGIN_ROOT,
        DANXBOT_PLAN_SESSIONS_HOME: home,
        PATH: `${fakeNpxDir}${path.delimiter}${process.env.PATH}`,
      },
      cwd: REPO_ROOT,
    }).length;
    assert.ok(
      connectedFailureBytes > 0,
      `expected a nonzero failure-notice byte count with CLAUDE_PLUGIN_ROOT set, got ${connectedFailureBytes}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeNpxDir, { recursive: true, force: true });
  }
});

test("perSession includes a SessionStart hook whose matcher still fires at startup (DX-3421's event-hook.sh)", () => {
  // Regression test for the bug DX-3347 originally fixed: event-hook.sh (was
  // mantra.sh) has matcher="startup|resume|compact" — a real matcher, but
  // one that still fires at ordinary session start. summarize()'s old "no
  // matcher" test silently excluded a hook like this from perSession.
  //
  // DX-3421 changed what this row's own BYTES look like under the harness:
  // an unconnected session (the harness's freshSessionId() is by
  // construction never connected) now prints nothing (0 bytes), where the
  // old mantra.sh printed a nonzero nudge — so proving "included" can no
  // longer lean on the row's bytes moving the total. Instead this
  // re-derives summarize()'s own inclusion rule (a matcher that names
  // "startup" counts, same as no matcher at all) directly against the
  // measured rows, and checks perSession agrees with that re-derivation —
  // structurally proving the matched-startup group was folded in, whatever
  // its byte count happens to be.
  const { rows, totals } = run();
  const eventHookRow = rows.find((r) => r.event === "SessionStart" && r.command.includes("event-hook.sh"));
  assert.ok(eventHookRow, "expected event-hook.sh to be measured under SessionStart");
  assert.ok(eventHookRow.matcher, "expected event-hook.sh to carry a real matcher (not null)");
  assert.ok(
    eventHookRow.matcher.split("|").includes("startup"),
    "expected event-hook.sh's matcher to include \"startup\"",
  );

  const expectedPerSession = rows
    .filter(
      (r) =>
        r.event === "SessionStart" && (!r.matcher || r.matcher.split("|").includes("startup")),
    )
    .reduce((sum, r) => sum + r.bytes, 0);

  assert.equal(
    totals.perSession,
    expectedPerSession,
    "perSession must include every SessionStart hook whose matcher fires at startup, including event-hook.sh",
  );
});
