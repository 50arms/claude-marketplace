// base deny-destructive-db hook — DX-3226.
//
// The bash predecessor shipped with NO test, the only guard in its PreToolUse
// group without one. That is why it spent its whole life refusing
// `grep -rn "DROP DATABASE" .` and `echo "... DROP DATABASE ..."` without
// anyone noticing.
//
// Like its git sibling, this suite does NOT hand-maintain a second list of
// example commands that could drift from the hook. It reads the `FORM:` /
// `ALLOWED-FORM:` lines directly OUT OF deny-destructive-db.mjs's own comments
// and runs each one through the REAL hook as a subprocess, so a bullet that
// claims coverage the code does not have fails here instead of drifting
// silently.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "deny-destructive-db.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

/** Runs the REAL hook exactly as Claude Code invokes it. Returns "deny" | "allow". */
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

/** Extracts every `FORM: <cmd>` / `ALLOWED-FORM: <cmd>` line from the hook's own comments. */
function extractExamples(source, label) {
  const re = new RegExp(`^(?:#|//)\\s*${label}:\\s*(.+)$`, "gm");
  const out = [];
  let m;
  while ((m = re.exec(source))) out.push(m[1].trim());
  return out;
}

const destructiveForms = extractExamples(SOURCE, "FORM");
const allowedForms = extractExamples(SOURCE, "ALLOWED-FORM");

// If these ever read zero, the extraction regex stopped matching the comment
// convention and every generated test below would pass vacuously — the silent
// drift this file exists to prevent.
test("the hook documents at least one FORM and one ALLOWED-FORM example", () => {
  assert.ok(destructiveForms.length >= 7, `found ${destructiveForms.length} FORM lines`);
  assert.ok(allowedForms.length >= 5, `found ${allowedForms.length} ALLOWED-FORM lines`);
});

describe("every form the comment documents as destructive is actually refused", () => {
  for (const cmd of destructiveForms) {
    test(cmd, () => assert.equal(decide(cmd), "deny", `expected DENY: ${cmd}`));
  }
});

describe("every form the comment documents as allowed still passes", () => {
  for (const cmd of allowedForms) {
    test(cmd, () => assert.equal(decide(cmd), "allow", `expected ALLOW: ${cmd}`));
  }
});

describe("the 2026-05-15 incident shape, and the wrappers it arrived through", () => {
  test("the original command is refused", () =>
    assert.equal(
      decide("docker exec -w /var/www/html/.danxbot/worktrees/harry gpt-manager-laravel.test-1 php artisan migrate:fresh --drop-views --drop-types"),
      "deny",
    ));
  test("wrapped in sh -c", () => assert.equal(decide(`sh -c 'php artisan migrate:fresh'`), "deny"));
  test("behind sudo", () => assert.equal(decide("sudo php artisan db:wipe"), "deny"));
  test("after a harmless first command", () => assert.equal(decide("echo starting && php artisan migrate:reset"), "deny"));
});

describe("DX-3226 — the executing program decides, not the text", () => {
  // These six are the whole point. The first three were DENIED by the bash
  // predecessor; the last three must never stop being denied, and each carries
  // the dangerous text in exactly the same structural place as a search does.
  test("searching for the SQL is allowed", () =>
    assert.equal(decide('grep -rn "DROP DATABASE" .'), "allow"));
  test("printing the SQL is allowed", () =>
    assert.equal(decide('echo "never run DROP DATABASE here"'), "allow"));
  test("a commit message naming the migration command is allowed", () =>
    assert.equal(decide('git commit -m "docs: php artisan migrate:fresh is banned"'), "allow"));

  test("a client executing the SQL is refused", () =>
    assert.equal(decide('psql -c "DROP DATABASE laravel"'), "deny"));
  test("an UNLISTED program executing the SQL is refused (fail closed)", () =>
    assert.equal(decide('some-unknown-db-client --exec "DROP DATABASE laravel"'), "deny"));
  test("SQL mid-statement is refused", () =>
    assert.equal(decide('psql -c "BEGIN; DROP SCHEMA public CASCADE;"'), "deny"));
});

describe("reversible operations stay allowed", () => {
  test("migrate:rollback", () => assert.equal(decide("php artisan migrate:rollback"), "allow"));
  test("a plain migrate", () => assert.equal(decide("php artisan migrate --force"), "allow"));
  test("a table-level drop is out of scope, as before", () =>
    assert.equal(decide('psql -c "DROP TABLE users"'), "allow"));
});

// DX-3396 — this guard was registered for the Bash tool only, so on this
// machine's primary shell (PowerShell) the same commands went unchecked. The
// script's own tokenizer already branches on `toolName === "PowerShell"`;
// only the hooks.json matcher was missing.
describe("DX-3396 — PowerShell tool input", () => {
  test("migrate:fresh from the PowerShell tool is denied", () =>
    assert.equal(decide("php artisan migrate:fresh", "PowerShell"), "deny"));
  test("an ordinary command from the PowerShell tool is allowed", () =>
    assert.equal(decide("php artisan migrate --force", "PowerShell"), "allow"));
});
