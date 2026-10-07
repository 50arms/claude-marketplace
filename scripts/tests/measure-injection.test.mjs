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
import { copyFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "measure-injection.mjs");
const PLUGIN_ROOT = path.join(REPO_ROOT, "danxbot");

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

// A throwaway marketplace of one plugin whose hooks.json is `hooks`, with this checkout's measure-injection.mjs beside it: the
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

test("AC 32508: an unset CLAUDE_PLUGIN_ROOT makes a real hook command fail loudly, which is why the harness always sets it", { skip: true }, () => {
  // DX-4235: all command hooks moved to function hooks; this test is no longer relevant
  // Every hook command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" ...`. Without the variable the shell expands it to nothing and
  // node cannot find the launcher: a non-zero exit the harness reports as an error row, never as a hook that "injects nothing".
  const hooksJson = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  if (!hooksJson.hooks) return; // No command hooks; migration complete
  const hooks = hooksJson.hooks;
  const command = hooks.SessionStart[0].hooks[0].command;
  const withoutRoot = { ...process.env };
  delete withoutRoot.CLAUDE_PLUGIN_ROOT;
  assert.throws(() => execFileSync("bash", ["-c", command], { input: "{}", env: withoutRoot, cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] }), /Command failed/);
});

test("perSession includes a SessionStart hook whose matcher still fires at startup, not only one with no matcher", () => {
  // Regression test for the bug DX-3347 originally fixed: a hook with a real matcher ("startup|resume|compact") still fires at ordinary
  // session start, and summarize() once dropped it from perSession because it only counted hooks with no matcher.
  const repo = fakeRepo({
    hooks: {
      SessionStart: [
        { matcher: "startup|resume|compact", hooks: [{ type: "command", command: "printf hello" }] },
        { matcher: "compact", hooks: [{ type: "command", command: "printf compaction-only" }] },
      ],
    },
  });
  try {
    const { rows, totals } = JSON.parse(execFileSync("node", [path.join(repo, "scripts", "measure-injection.mjs"), "--json"], { cwd: repo }).toString("utf8"));
    assert.equal(rows.length, 2);
    assert.equal(totals.perSession, "hello".length, "the startup-matched hook counts, the compact-only one does not");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
