// event-hook.sh — danxbot plugin's single SessionStart/SubagentStart hook
// (DX-3421). Replaces `mantra.sh`, `plan-workflow-autoload.sh` and
// `compaction-skill-reload.sh` (all deleted): not connected to a plan ->
// silent, for both events, no nudge and no mantra.md fallback at all
// (operator verdict, DX-3421 comment 7748/7752). Connected -> resolves the
// danxbot event name from the Claude hook event + SessionStart's `source`
// field, fetches that event's effective text from the dashboard's reminder
// registry via `danx-dashboard-mcp event-text <event>`, and prints exactly
// that text (SessionStart: plain stdout; SubagentStart:
// hookSpecificOutput.additionalContext JSON). A fetch failure always prints
// one line naming the event and the failure reason — never silent, never a
// `mantra.md` reread.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "event-hook.sh");

let home;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "event-hook-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function connect(sessionId) {
  const dir = path.join(home, ".config", "danxbot", "plan-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1 }));
}

function runHook(event, { sessionId = "test-session", source, extraEnv = {} } = {}) {
  const payload = { session_id: sessionId };
  if (source !== undefined) payload.source = source;
  return spawnSync("bash", [SCRIPT, event], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, DANXBOT_PLAN_SESSIONS_HOME: home, ...extraEnv },
  });
}

// A fake `npx` placed FIRST on PATH so event-hook.sh's registry-fetch step
// (`npx -y @thehammer/danx-dashboard-mcp@... event-text <event>`) resolves
// to this script instead of the real one — no test here ever touches the
// network. Records the args it was called with (minus the leading `-y
// <package>`) into $FAKE_NPX_ARGS_FILE so a test can assert which event name
// the hook actually requested. Modes (`$FAKE_EVENT_HOOK_NPX_MODE`):
//   "success" -> prints $FAKE_EVENT_HOOK_NPX_TEXT to stdout, exit 0
//   "empty"   -> prints nothing, exit 0 (the "reported-clean but empty"
//                case the hook must still treat as a failure)
//   "fail"    -> prints $FAKE_EVENT_HOOK_NPX_STDERR (or a default) to
//                stderr only, exit 1
function makeFakeNpx() {
  const binDir = mkdtempSync(path.join(tmpdir(), "event-hook-fake-npx-"));
  const scriptPath = path.join(binDir, "npx");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "# Fake npx for event-hook.sh tests (DX-3421) — never touches the network.",
      'if [ -n "${FAKE_NPX_ARGS_FILE:-}" ]; then printf \'%s\\n\' "$*" > "$FAKE_NPX_ARGS_FILE"; fi',
      'case "${FAKE_EVENT_HOOK_NPX_MODE:-fail}" in',
      '  success) printf \'%s\' "${FAKE_EVENT_HOOK_NPX_TEXT:-}" ;;',
      "  empty)   exit 0 ;;",
      '  *) echo "${FAKE_EVENT_HOOK_NPX_STDERR:-fake npx: forced failure}" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  spawnSync("chmod", ["755", scriptPath]);
  return binDir;
}

function runHookWithFakeNpx(mode, { event = "SessionStart", sessionId = "connected-session", source = "startup", text = "", stderrText } = {}) {
  const fakeBinDir = makeFakeNpx();
  const argsFile = path.join(fakeBinDir, "args.txt");
  connect(sessionId);
  try {
    const result = runHook(event, {
      sessionId,
      source,
      extraEnv: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
        FAKE_EVENT_HOOK_NPX_MODE: mode,
        FAKE_EVENT_HOOK_NPX_TEXT: text,
        FAKE_EVENT_HOOK_NPX_STDERR: stderrText ?? "",
        FAKE_NPX_ARGS_FILE: argsFile,
      },
    });
    let calledArgs = null;
    try {
      calledArgs = readFileSync(argsFile, "utf8").trim();
    } catch {
      /* fake npx never ran */
    }
    return { ...result, calledArgs };
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

describe("event-hook.sh — not connected to a plan: silent, both events", () => {
  test("SessionStart(startup), not connected: empty stdout, exit 0", () => {
    const result = runHook("SessionStart", { source: "startup" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("SessionStart(resume), not connected: empty stdout, exit 0", () => {
    const result = runHook("SessionStart", { source: "resume" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("SessionStart(compact), not connected: empty stdout, exit 0", () => {
    const result = runHook("SessionStart", { source: "compact" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("SubagentStart, not connected: empty stdout (no additionalContext envelope either), exit 0", () => {
    const result = runHook("SubagentStart", {});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

describe("event-hook.sh — connected: resolves the right danxbot event and prints its text", () => {
  test("SessionStart(startup) requests session_start, prints the fetched text plain", () => {
    const result = runHookWithFakeNpx("success", { source: "startup", text: "The start text." });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The start text.\n");
    assert.match(result.calledArgs, /event-text session_start$/);
  });

  test("SessionStart(resume) requests session_resume", () => {
    const result = runHookWithFakeNpx("success", { source: "resume", text: "The resume text." });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The resume text.\n");
    assert.match(result.calledArgs, /event-text session_resume$/);
  });

  test("SessionStart(compact) requests after_compaction", () => {
    const result = runHookWithFakeNpx("success", { source: "compact", text: "The compaction text." });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The compaction text.\n");
    assert.match(result.calledArgs, /event-text after_compaction$/);
  });

  test("SubagentStart requests sub_agent_start, wraps the text in the additionalContext JSON envelope", () => {
    const result = runHookWithFakeNpx("success", { event: "SubagentStart", text: "The mantra alone." });
    assert.equal(result.status, 0);
    assert.match(result.calledArgs, /event-text sub_agent_start$/);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "The mantra alone.");
  });

  test("an unrecognized SessionStart source (defensive: the matcher should never let this through) is silent, never fetches", () => {
    const result = runHookWithFakeNpx("success", { source: "clear", text: "should never print" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.calledArgs, null, "expected the hook to never invoke npx for an unrecognized source");
  });
});

describe("event-hook.sh — fetch failure: always reported, never silent, no mantra.md fallback", () => {
  test("a hard failure (network/auth/etc.) prints ONE line naming the event and the reason, exit 0", () => {
    const result = runHookWithFakeNpx("fail", { source: "startup", stderrText: "not_found: could not fetch the effective \"session_start\" text from the dashboard" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Could not load the "session_start" event text/);
    assert.match(result.stdout, /not_found/);
    assert.match(result.stdout, /Tell the operator/i);
  });

  test("a reported-clean exit with EMPTY stdout is still treated as a failure, never a silent success", () => {
    const result = runHookWithFakeNpx("empty", { source: "startup" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Could not load the "session_start" event text/);
  });

  test("SubagentStart fetch failure still emits a plain failure line (not wrapped in the JSON envelope) — same contract as SessionStart's notice", () => {
    const result = runHookWithFakeNpx("fail", { event: "SubagentStart", stderrText: "timeout" });
    assert.equal(result.status, 0);
    // SubagentStart's `emit` wraps EVERY string it's given (success or
    // failure alike) in the additionalContext envelope — the failure
    // notice is no exception, so the agent still sees it as context.
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Could not load the "sub_agent_start" event text/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /timeout/);
  });
});

describe("event-hook.sh — no other event is handled", () => {
  test("an unknown hook event name is a silent no-op", () => {
    const result = runHook("SomeOtherEvent", {});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});
