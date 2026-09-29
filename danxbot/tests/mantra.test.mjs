// mantra.sh — danxbot plugin. DX-3347, gated DX-3275, registry-backed as of
// DX-3366.
// Not connected to a plan: prints only the short plan-workflow nudge.
// Connected (session connection record present): fetches the effective
// mantra text from the dashboard's reminder registry via the published
// `@thehammer/danx-dashboard-mcp` package's `mantra` subcommand — never the
// real `npx`/network in these tests, which stub it out via a fake `npx` on
// PATH (see `makeFakeNpx` below) so every case here stays deterministic and
// offline. Any registry-fetch failure (including a reported-clean exit with
// empty stdout — never trusted as a silent success) falls back to printing
// `danxbot/mantra.md` verbatim, plus exactly one short notice line.
// SubagentStart (DX-3384, matcher "^danxbot:worker-"): the same text as an
// `additionalContext` JSON envelope; not connected, mantra.md itself. No-ops
// on any other event.
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "mantra.sh");
const MANTRA_FILE = path.join(PLUGIN_ROOT, "mantra.md");

let home;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mantra-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function connect(sessionId) {
  const dir = path.join(home, ".config", "danxbot", "plan-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1 }));
}

function runHook(event, sessionId = "test-session", extraEnv = {}) {
  return spawnSync("bash", [SCRIPT, event], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, DANXBOT_PLAN_SESSIONS_HOME: home, ...extraEnv },
  });
}

// A fake `npx` placed FIRST on PATH so mantra.sh's registry-fetch step
// (`npx -y @thehammer/danx-dashboard-mcp@... mantra`) resolves to this
// script instead of the real one — no test here ever touches the network.
// Modes:
//   "success" -> prints $FAKE_MANTRA_NPX_TEXT to stdout, exit 0
//   "empty"   -> prints nothing, exit 0 (the "reported-clean but empty"
//                case mantra.sh must still treat as a failure)
//   "fail"    -> prints to stderr only, exit 1
function makeFakeNpx() {
  const binDir = mkdtempSync(path.join(tmpdir(), "mantra-fake-npx-"));
  const scriptPath = path.join(binDir, "npx");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "# Fake npx for mantra.sh tests (DX-3366) — never touches the network.",
      'case "${FAKE_MANTRA_NPX_MODE:-fail}" in',
      '  success) printf \'%s\' "${FAKE_MANTRA_NPX_TEXT:-}" ;;',
      "  empty)   exit 0 ;;",
      '  *) echo "fake npx: forced failure" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(scriptPath, 0o755);
  return binDir;
}

function runHookWithFakeNpx(mode, { event = "SessionStart", sessionId = "connected-session", text = "" } = {}) {
  const fakeBinDir = makeFakeNpx();
  try {
    return runHook(event, sessionId, {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_MANTRA_NPX_MODE: mode,
      FAKE_MANTRA_NPX_TEXT: text,
    });
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

describe("mantra.sh", () => {
  test("not connected: prints only the plan-workflow nudge, not the mantra", () => {
    const result = runHook("SessionStart", "not-connected-session");
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /danxbot:plan-workflow/);
    assert.match(result.stdout, /ASK the operator/);
    assert.doesNotMatch(result.stdout, /\*\*Orchestrate\*\*/);
    // ~0.5 KB target (AC 35058) — a hard byte ceiling would be brittle, so this
    // asserts the class of size rather than an exact count.
    assert.ok(
      Buffer.byteLength(result.stdout) < 700,
      `nudge is ${Buffer.byteLength(result.stdout)} bytes, expected well under 700`,
    );
  });

  test("connected + registry reachable: prints the fetched effective text, not the committed file (AC 35446)", () => {
    connect("connected-session");
    const result = runHookWithFakeNpx("success", { text: "LIVE REGISTRY MANTRA TEXT" });
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout, "LIVE REGISTRY MANTRA TEXT\n");
    assert.doesNotMatch(result.stdout, /reminder registry/i);
    const fileContent = readFileSync(MANTRA_FILE, "utf8");
    assert.notEqual(result.stdout, fileContent);
  });

  test("connected + registry fetch fails (nonzero exit): falls back to committed mantra.md plus exactly one notice line (AC 35447)", () => {
    connect("connected-session");
    const result = runHookWithFakeNpx("fail");
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /Could not reach the reminder registry/i);
    const fileContent = readFileSync(MANTRA_FILE, "utf8");
    assert.ok(result.stdout.endsWith(fileContent), "expected fallback output to end with mantra.md's exact content");
    const notice = result.stdout.slice(0, result.stdout.length - fileContent.length);
    assert.equal(
      notice.split("\n").filter(Boolean).length,
      1,
      `expected exactly one notice line, got: ${JSON.stringify(notice)}`,
    );
  });

  test("connected + registry fetch reports a clean exit but empty stdout: never trusted as a silent success, falls back (AC 35447)", () => {
    connect("connected-session");
    const result = runHookWithFakeNpx("empty");
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /Could not reach the reminder registry/i);
    const fileContent = readFileSync(MANTRA_FILE, "utf8");
    assert.ok(result.stdout.endsWith(fileContent), "expected fallback output to end with mantra.md's exact content");
  });

  test("mantra.md is the canonical rule list (PLN-11 R-22) and names no sub-agent count (R-23)", () => {
    const text = readFileSync(MANTRA_FILE, "utf8");
    for (const rule of ["Orchestrate", "Evidence", "Decide, don't wait", "A question is not a stop", "Zero context", "Worktrees", "Craft", "Chat"]) {
      assert.ok(text.includes(`**${rule}`), `missing rule: ${rule}`);
    }
    assert.doesNotMatch(text, /\b(cap|keep)\s+\d|\d+\s+(sub-agents|in flight)/i);
  });

  test("any event but SessionStart/SubagentStart is a silent no-op, connected or not", () => {
    connect("test-session");
    const result = runHook("UserPromptSubmit");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

// DX-3384 (DX-3478 problem 1769) — every danxbot:worker-* sub-agent receives
// the same registry mantra through SubagentStart's additionalContext.
describe("mantra.sh SubagentStart", () => {
  function additionalContext(result) {
    assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SubagentStart");
    return parsed.hookSpecificOutput.additionalContext;
  }
  const mantraFileText = () => readFileSync(MANTRA_FILE, "utf8").replace(/\n+$/, "");

  test("not connected: the committed mantra.md itself, never the nudge", () => {
    const context = additionalContext(runHook("SubagentStart", "not-connected-session"));
    assert.equal(context, mantraFileText());
    assert.doesNotMatch(context, /ASK the operator/);
  });

  test("connected + registry reachable: the fetched effective text", () => {
    connect("connected-session");
    const context = additionalContext(
      runHookWithFakeNpx("success", { event: "SubagentStart", text: "LIVE REGISTRY MANTRA TEXT" }),
    );
    assert.equal(context, "LIVE REGISTRY MANTRA TEXT");
  });

  test("connected + registry fetch fails: one notice line, then mantra.md", () => {
    connect("connected-session");
    const context = additionalContext(runHookWithFakeNpx("fail", { event: "SubagentStart" }));
    const [notice, ...rest] = context.split("\n");
    assert.match(notice, /Could not reach the reminder registry/i);
    assert.equal(rest.join("\n"), mantraFileText());
  });

  test("hooks.json wires SubagentStart to mantra.sh with a matcher covering every worker tier and nothing else", () => {
    const hooks = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
    assert.equal(hooks.SubagentStart.length, 1);
    const [group] = hooks.SubagentStart;
    assert.equal(group.hooks[0].command, "bash ${CLAUDE_PLUGIN_ROOT}/scripts/mantra.sh SubagentStart");
    const matcher = new RegExp(group.matcher);
    const agents = readdirSync(path.join(PLUGIN_ROOT, "agents")).filter((f) => f.endsWith(".md"));
    assert.ok(agents.length > 0);
    for (const file of agents) {
      const scoped = `danxbot:${file.replace(/\.md$/, "")}`;
      assert.ok(matcher.test(scoped), `${scoped} is not matched`);
    }
    for (const other of ["general-purpose", "Explore", "other-plugin:worker-x"]) {
      assert.ok(!matcher.test(other), `${other} must not match`);
    }
  });
});
