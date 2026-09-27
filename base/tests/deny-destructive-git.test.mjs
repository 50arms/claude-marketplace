// base deny-destructive-git hook — DX-3094.
//
// DX-3094's root cause: the guard's comment claimed coverage its PATTERN
// regex did not actually have, and nothing compared the two, so the gap was
// silent until an agent's command walked straight through it on 2026-09-21.
//
// This suite does NOT hand-maintain a second list of example commands that
// could itself drift from the script. It reads the `FORM:` / `ALLOWED-FORM:`
// example lines directly OUT OF deny-destructive-git.mjs's own comments (the
// single source of truth — see that file's denylist block) and runs each one
// through the REAL hook as a subprocess. A future editor who documents a new
// covered form without actually implementing it — or the reverse, narrows the
// denylist without updating the comment — makes one of these generated tests
// fail, instead of silently reintroducing DX-3094.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "deny-destructive-git.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

/**
 * Runs the REAL hook script as a subprocess, exactly the shape Claude Code
 * invokes it: JSON on stdin, `tool_input.command` carrying the candidate.
 * Returns "deny" | "allow".
 */
function decide(command, toolName = "Bash") {
  const result = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (result.stdout.trim() === "") return "allow";
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  return out.hookSpecificOutput.permissionDecision === "deny" ? "deny" : "allow";
}

/**
 * Extracts every `FORM: <cmd>` / `ALLOWED-FORM: <cmd>` line from the script's
 * own comments.
 *
 * DX-3223 — accepts BOTH comment markers. The hook was a bash script (`#`)
 * and is now an ES module (`//`). A `#`-only pattern would silently extract
 * ZERO examples from the new file, and every generated test below would
 * vacuously pass — the exact silent-drift failure this suite exists to
 * prevent, reintroduced by the rewrite that was meant to preserve it. The
 * count assertions below are what catch it, so they are load-bearing, not
 * decoration.
 */
function extractExamples(source, label) {
  const re = new RegExp(`^(?:#|//)\\s*${label}:\\s*(.+)$`, "gm");
  const out = [];
  let m;
  while ((m = re.exec(source))) out.push(m[1].trim());
  return out;
}

const destructiveForms = extractExamples(SOURCE, "FORM");
const allowedForms = extractExamples(SOURCE, "ALLOWED-FORM");

// Sanity on the extraction itself — if these are ever zero, the regex above
// stopped matching the comment convention and every test below would
// vacuously pass, which is exactly the silent-drift failure mode this file
// exists to prevent.
test("the script documents at least one FORM and one ALLOWED-FORM example", () => {
  assert.ok(destructiveForms.length >= 8, `found ${destructiveForms.length} FORM lines`);
  assert.ok(allowedForms.length >= 5, `found ${allowedForms.length} ALLOWED-FORM lines`);
});

describe("every form the comment documents as destructive is actually refused (DX-3094 AC1)", () => {
  for (const cmd of destructiveForms) {
    test(cmd, () => assert.equal(decide(cmd), "deny", `expected DENY: ${cmd}`));
  }
});

describe("every form the comment documents as allowed still passes (DX-3094 AC3)", () => {
  for (const cmd of allowedForms) {
    test(cmd, () => assert.equal(decide(cmd), "allow", `expected ALLOW: ${cmd}`));
  }
});

describe("--abort carve-out (unaffected by this card, re-proven)", () => {
  test("rebase --abort is allowed", () => assert.equal(decide("git rebase --abort"), "allow"));
  test("merge --abort is allowed", () => assert.equal(decide("git merge --abort"), "allow"));
});

describe("the 2026-09-21 incident shape — a starting point named before the discard marker (DX-3094 AC6)", () => {
  // DX-3094's own description is the authoritative spec of the missed shape
  // ("It does not catch the same command when a starting point is named
  // first"). DX-3089, the card DX-3094's evidence cites as "the report that
  // disclosed the command", does not in fact name one — its actual content
  // (checked directly) is an unrelated quality-gate test-fixture bug. That
  // citation appears to be a mismatch in DX-3094's own evidence section, not
  // something this fix can resolve; the incident shape below is taken from
  // DX-3094's prose description instead, which is unambiguous.
  test("checkout <ref> -- <path> is refused", () => assert.equal(decide("git checkout origin/main -- src/agent/launcher.ts"), "deny"));
  test("checkout <ref> -- <path> with a relative ref is refused", () => assert.equal(decide("git checkout HEAD~1 -- file.txt"), "deny"));
});

describe("plain command text that only mentions these strings is not itself a git invocation", () => {
  test("a commit message quoting reset --hard is not blocked", () =>
    assert.equal(decide('git commit -m "note: never run reset --hard here"'), "allow"));
});

// DX-3223. The case directly above passed against the OLD bash hook too — but
// for the wrong reason, and that is the whole point of this block. Its message
// says "reset --hard" with no `git` in front, and the old regex required the
// literal word `git` before the subcommand. So it looked like it covered
// prose, while the shape that actually occurs in practice — a message that
// names the full command — was still blocked. A guard test that passes for a
// reason unrelated to what it claims to prove is worse than no test: it is why
// this defect survived in a file written specifically to stop that class of
// drift (DX-3094).
//
// Every case below therefore names the FULL command, `git` included, in a
// position where it is an argument rather than an invocation. All three were
// reproduced first-hand on 2026-09-23 against the old hook, each one blocking
// a session that was not running git at all.
describe("DX-3223 — command position, not raw text", () => {
  test("a commit message naming the full command is allowed", () =>
    assert.equal(decide('git commit -m "docs: explain why git stash is banned"'), "allow"));

  test("a search whose PATTERN is the command is allowed", () =>
    assert.equal(decide("grep -rn 'git reset --hard' ."), "allow"));

  test("writing a file whose CONTENT names the command is allowed", () =>
    assert.equal(decide("printf '%s' 'git checkout -- file.txt' > note.txt"), "allow"));

  // The other half of the contract: tokenizing must not let a real invocation
  // through, however it is wrapped. `simpleCommands()` recurses into nested
  // interpreter strings, so argv[0] is still found.
  test("a real invocation wrapped in sh -c is still refused", () =>
    assert.equal(decide("sh -c 'git stash'"), "deny"));

  test("a real invocation behind sudo is still refused", () =>
    assert.equal(decide("sudo git reset --hard origin/main"), "deny"));

  test("a real invocation after a harmless first command is still refused", () =>
    assert.equal(decide("echo starting && git clean -fd"), "deny"));
});

// DX-3396 — this guard was registered for the Bash tool only, so on this
// machine's primary shell (PowerShell) the same commands went unchecked. The
// script's own tokenizer (simpleCommands in lib/shell-commands.mjs) already
// branches on `toolName === "PowerShell"`; only the hooks.json matcher was
// missing. These cases pass `tool_name: "PowerShell"` to prove the script side
// was already correct, and the hooks.json fix (Bash|PowerShell matcher) is
// what actually wires it in.
describe("DX-3396 — PowerShell tool input", () => {
  test("git reset --hard from the PowerShell tool is denied", () =>
    assert.equal(decide("git reset --hard origin/main", "PowerShell"), "deny"));
  test("git stash from the PowerShell tool is denied", () =>
    assert.equal(decide("git stash", "PowerShell"), "deny"));
  test("an ordinary git command from the PowerShell tool is allowed", () =>
    assert.equal(decide("git status", "PowerShell"), "allow"));
});
