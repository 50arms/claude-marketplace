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
import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NPX_TRIPWIRE, TEST_VERSION, fakeNpm, installFakeMcp, makeFakeBinDir, recordFilePath, recordVersion, writeFakeBinSourceFile } from "./fixtures/fake-dashboard-mcp.mjs";
import { REGISTRY_BASE_URL_ENV, startFakeRegistry } from "./fixtures/fake-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "event-hook.sh");

// DX-4321: a SessionStart refreshes the recorded danx-dashboard-mcp version from the registry, so
// every hook run here has a fake one to ask (never npm itself). It serves TEST_VERSION until a test
// moves it; `installFakeMcp` records the same version, so a refresh changes nothing by default.
const registry = await startFakeRegistry({ version: TEST_VERSION });
after(() => registry.stop());

let home;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "event-hook-test-"));
  registry.setVersion(TEST_VERSION);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function connect(sessionId) {
  const dir = path.join(home, ".config", "danxbot", "plan-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ schemaVersion: 1 }));
}

function runHook(event, { sessionId = "test-session", source, cwd, extraEnv = {} } = {}) {
  const payload = { session_id: sessionId };
  if (cwd !== undefined) payload.cwd = cwd;
  if (source !== undefined) payload.source = source;
  return spawnSync("bash", [SCRIPT, event], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, DANXBOT_PLAN_SESSIONS_HOME: home, [REGISTRY_BASE_URL_ENV]: registry.url, ...extraEnv },
  });
}

// The registry fetch runs the recorded package version's installed bin with `node` (DX-3811), so
// these tests install a FAKE bin where ensure-dashboard-mcp.sh would (fixtures/
// fake-dashboard-mcp.mjs) — no test here touches the network. A tripwire `npx` sits first
// on PATH: the hook must never reach it. Modes (`mode`): "success" prints the text,
// "empty" prints nothing and exits 0, "fail" prints stderr and exits 1, "silent-fail"
// exits 3 with no output, "hang" never returns.
function runHookWithFakeMcp(
  mode,
  { event = "SessionStart", sessionId = "connected-session", source = "startup", text = "", stderrText, installed = true, recordedOnly, registryUrl, fetchTimeoutSecs, npmMode, connected = true, cwd } = {},
) {
  const fakeBinDir = makeFakeBinDir({ npx: NPX_TRIPWIRE, npm: fakeNpm() });
  const dataDir = mkdtempSync(path.join(tmpdir(), "event-hook-plugin-data-"));
  const argsFile = path.join(fakeBinDir, "args.txt");
  const npxCallsFile = path.join(fakeBinDir, "npx-calls.txt");
  const npmCallsFile = path.join(fakeBinDir, "npm-calls.txt");
  if (installed) installFakeMcp(dataDir);
  if (recordedOnly) recordVersion(dataDir, recordedOnly); // a record, with nothing installed for it
  if (connected) connect(sessionId);
  const requestsBefore = registry.requests().length;
  try {
    const extraEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_DATA: dataDir,
      FAKE_MCP_MODE: mode,
      FAKE_MCP_TEXT: text,
      FAKE_MCP_STDERR: stderrText ?? "",
      FAKE_MCP_ARGS_FILE: argsFile,
      FAKE_NPX_CALLS_FILE: npxCallsFile,
      FAKE_NPM_CALLS_FILE: npmCallsFile,
      FAKE_BIN_SOURCE_FILE: writeFakeBinSourceFile(),
    };
    if (fetchTimeoutSecs !== undefined) extraEnv.EVENT_TEXT_FETCH_TIMEOUT_SECS = String(fetchTimeoutSecs);
    if (npmMode !== undefined) extraEnv.FAKE_NPM_MODE = npmMode;
    if (registryUrl !== undefined) extraEnv[REGISTRY_BASE_URL_ENV] = registryUrl;
    const result = runHook(event, { sessionId, source, cwd, extraEnv });
    const readOrNull = (file) => {
      try {
        return readFileSync(file, "utf8").trim();
      } catch {
        return null; // never written: the fake never ran
      }
    };
    return {
      ...result,
      calledArgs: readOrNull(argsFile),
      npxCalls: readOrNull(npxCallsFile),
      npmCalls: readOrNull(npmCallsFile),
      registryRequests: registry.requests().length - requestsBefore,
      recorded: readOrNull(recordFilePath(dataDir)),
    };
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("event-hook.sh — not connected to a plan: silent, both events", () => {
  test("SessionStart(startup), not connected, no earlier connected session in the project: empty stdout, exit 0", () => {
    // DX-3928: the restart-notice lookup runs here and finds nothing (exit 0, empty).
    const result = runHookWithFakeMcp("empty", { source: "startup", connected: false });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("SessionStart(resume), not connected, no earlier connected session in the project: empty stdout, exit 0", () => {
    // DX-3928: the restart-notice lookup runs here and finds nothing (exit 0, empty).
    const result = runHookWithFakeMcp("empty", { source: "resume", connected: false });
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
    const result = runHookWithFakeMcp("success", { source: "startup", text: "The start text." });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The start text.\n");
    assert.match(result.calledArgs, /event-text session_start$/);
  });

  test("SessionStart(resume) requests session_resume", () => {
    const result = runHookWithFakeMcp("success", { source: "resume", text: "The resume text." });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The resume text.\n");
    assert.match(result.calledArgs, /event-text session_resume$/);
  });

  test("SessionStart(compact) requests after_compaction", () => {
    const result = runHookWithFakeMcp("success", { source: "compact", text: "The compaction text." });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The compaction text.\n");
    assert.match(result.calledArgs, /event-text after_compaction$/);
  });

  test("SubagentStart requests sub_agent_start, wraps the text in the additionalContext JSON envelope", () => {
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: "The mantra alone." });
    assert.equal(result.status, 0);
    assert.match(result.calledArgs, /event-text sub_agent_start$/);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "The mantra alone.");
  });

  test("an unrecognized SessionStart source (defensive: the matcher should never let this through) is silent, never fetches", () => {
    const result = runHookWithFakeMcp("success", { source: "clear", text: "should never print" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.calledArgs, null, "expected the hook to never fetch for an unrecognized source");
  });
});

describe("event-hook.sh — fetch failure: always reported, never silent, no mantra.md fallback", () => {
  test("a hard failure (network/auth/etc.) prints ONE line naming the event and the reason, exit 0", () => {
    const result = runHookWithFakeMcp("fail", { source: "startup", stderrText: "not_found: could not fetch the effective \"session_start\" text from the dashboard" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Could not load the "session_start" event text/);
    assert.match(result.stdout, /not_found/);
    assert.match(result.stdout, /Tell the operator/i);
  });

  test("a reported-clean exit with EMPTY stdout is still treated as a failure, never a silent success", () => {
    const result = runHookWithFakeMcp("empty", { source: "startup" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Could not load the "session_start" event text/);
    assert.match(result.stdout, /empty_response/, "names the empty response, never an unknown error");
    assert.doesNotMatch(result.stdout, /unknown error/);
  });

  test("SubagentStart fetch failure still emits a plain failure line (not wrapped in the JSON envelope) — same contract as SessionStart's notice", () => {
    const result = runHookWithFakeMcp("fail", { event: "SubagentStart", stderrText: "timeout" });
    assert.equal(result.status, 0);
    // SubagentStart's `emit` wraps EVERY string it's given (success or
    // failure alike) in the additionalContext envelope — the failure
    // notice is no exception, so the agent still sees it as context.
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Could not load the "sub_agent_start" event text/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /timeout/);
  });
});

describe("event-hook.sh — DX-3811: the fetch never depends on a cold npx", () => {
  // Regression for DX-3811: the hook used to run `timeout 8s npx -y <pin> event-text …`; a
  // cold or contended npx outlived the 8 s and about 1 in 9 sub-agents got the failure
  // notice instead of the mantra. Against that code the tripwire npx below is called
  // and the hook reports a failure, so these tests fail there.
  test("SubagentStart delivers the mantra from the installed package and never calls npx", () => {
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: "The mantra alone." });
    assert.equal(result.npxCalls, null, `the hook must not run npx, but it did: ${result.npxCalls}`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "The mantra alone.");
    assert.equal(result.npmCalls, null, "an already-installed package is not installed again");
  });

  test("SessionStart never calls npx either", () => {
    const result = runHookWithFakeMcp("success", { source: "startup", text: "The start text." });
    assert.equal(result.npxCalls, null);
    assert.equal(result.stdout, "The start text.\n");
  });

  test("when the package is not installed yet, the hook installs it once and then delivers the mantra", () => {
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: "The mantra alone.", installed: false });
    assert.equal(result.npxCalls, null);
    assert.equal(result.npmCalls.split("\n").length, 1, "exactly one install");
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "The mantra alone.");
  });

  test("a cold install that outlasts the fetch budget does not eat it: the mantra is still delivered", () => {
    // The install (2 s here) runs BEFORE the fetch's 1 s budget starts. Were the install
    // inside the `timeout`, this would end in a timeout notice.
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: "The mantra alone.", installed: false, npmMode: "slow", fetchTimeoutSecs: 1 });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "The mantra alone.");
  });

  test("when the install fails, the notice carries the install failure's own reason", () => {
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", installed: false, npmMode: "fail" });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Could not load the "sub_agent_start" event text/);
    assert.match(context, /install_failed/);
    assert.match(context, /registry unreachable/);
    assert.doesNotMatch(context, /unknown error/);
    assert.equal(result.calledArgs, null, "no fetch is attempted without an installed package");
  });
});

describe("event-hook.sh — a failure always names its reason (DX-3811)", () => {
  test("a fetch that never returns is reported as a timeout, never as an unknown error", () => {
    const result = runHookWithFakeMcp("hang", { event: "SubagentStart", fetchTimeoutSecs: 1 });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Could not load the "sub_agent_start" event text/);
    assert.match(context, /timeout: no response within 1s/);
    assert.doesNotMatch(context, /unknown error/);
  });

  test("a fetch that dies silently names its exit code instead of an unknown error", () => {
    const result = runHookWithFakeMcp("silent-fail", { event: "SubagentStart" });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /exit_3/);
    assert.doesNotMatch(context, /unknown error/);
  });
});

describe("event-hook.sh — DX-3928: the restart notice for a not-connected session", () => {
  const notice = "Your previous session here was on plan PLN-2; 3 events are waiting. Run plan_connect.";

  for (const source of ["startup", "resume"]) {
    test(`SessionStart(${source}), not connected: prints the registry notice from restart-notice, never event-text`, () => {
      const result = runHookWithFakeMcp("success", { source, text: notice, connected: false, cwd: "proj-dir" });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `${notice}\n`);
      assert.match(result.calledArgs, /^restart-notice --cwd proj-dir$/);
      assert.equal(result.npxCalls, null);
    });
  }

  test("exit 0 with empty stdout (no earlier connected session in this project): completely silent", () => {
    const result = runHookWithFakeMcp("empty", { source: "startup", connected: false });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.calledArgs, /^restart-notice/);
  });

  test("a non-zero exit prints one could-not-load line carrying stderr's reason", () => {
    const result = runHookWithFakeMcp("fail", { source: "startup", connected: false, stderrText: "dashboard unreachable: ECONNREFUSED" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Could not load the restart notice/);
    assert.match(result.stdout, /ECONNREFUSED/);
    assert.equal(result.stdout.trim().split("\n").length, 1);
  });

  test("a silent non-zero exit still names its exit code", () => {
    const result = runHookWithFakeMcp("silent-fail", { source: "startup", connected: false });
    assert.match(result.stdout, /Could not load the restart notice \(exit_3/);
  });

  test("a lookup that never returns is reported as a timeout", () => {
    const result = runHookWithFakeMcp("hang", { source: "startup", connected: false, fetchTimeoutSecs: 1 });
    assert.match(result.stdout, /Could not load the restart notice \(timeout: no response within 1s/);
  });

  test("a failed install of the recorded package version is reported, no lookup attempted", () => {
    const result = runHookWithFakeMcp("success", { source: "startup", connected: false, installed: false, npmMode: "fail" });
    assert.match(result.stdout, /Could not load the restart notice/);
    assert.match(result.stdout, /install_failed/);
    assert.equal(result.calledArgs, null);
  });

  test("no cwd in the payload: the subcommand runs without --cwd", () => {
    const result = runHookWithFakeMcp("success", { source: "startup", text: notice, connected: false });
    assert.equal(result.calledArgs, "restart-notice");
  });

  test("compact and unrecognised sources never ask for a notice", () => {
    for (const source of ["compact", "clear"]) {
      const result = runHookWithFakeMcp("success", { source, text: notice, connected: false });
      assert.equal(result.stdout, "");
      assert.equal(result.calledArgs, null);
    }
  });

  test("SubagentStart of a not-connected session stays silent and never looks up a notice", () => {
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: notice, connected: false });
    assert.equal(result.stdout, "");
    assert.equal(result.calledArgs, null);
  });

  test("a connected session gets only its registry event text, never the restart notice", () => {
    const result = runHookWithFakeMcp("success", { source: "startup", text: "The start text." });
    assert.equal(result.stdout, "The start text.\n");
    assert.match(result.calledArgs, /^event-text session_start$/);
  });
});

describe("event-hook.sh — DX-4321: the registry's latest is read at session start and recorded; sub-agents read the record", () => {
  const A = "0.1.7";
  const B = "0.1.8";

  test("SessionStart after the registry's latest moved A to B records B, installs B, and runs it", () => {
    registry.setVersion(B);
    const result = runHookWithFakeMcp("success", { source: "startup", text: "The start text.", installed: false, recordedOnly: A });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "The start text.\n", "a successful refresh adds no line");
    assert.equal(result.recorded, B);
    assert.match(result.npmCalls, new RegExp(`@${B.replace(/\./g, "\\.")}$`));
    assert.match(result.calledArgs, /event-text session_start$/);
    assert.equal(result.registryRequests, 1);
  });

  test("SubagentStart reads the record and makes ZERO registry requests, even when the registry has moved on", () => {
    registry.setVersion(B);
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: "The mantra alone.", installed: false, recordedOnly: A });
    assert.equal(result.registryRequests, 0);
    assert.equal(result.recorded, A, "the record is left alone");
    assert.match(result.npmCalls, new RegExp(`@${A.replace(/\./g, "\\.")}$`), "the recorded version is what gets installed");
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "The mantra alone.");
  });

  test("SubagentStart with no record resolves it through the same function, once, and records it", () => {
    registry.setVersion(B);
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", text: "The mantra alone.", installed: false });
    assert.equal(result.registryRequests, 1);
    assert.equal(result.recorded, B);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "The mantra alone.");
  });

  test("a refresh that fails with a recorded version prints ONE line naming the reason and the version still in use, and keeps running that version", () => {
    registry.setMode("status-500");
    const result = runHookWithFakeMcp("success", { source: "startup", text: "The start text.", installed: true });
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2, `the refresh line, then the event text: ${result.stdout}`);
    assert.match(lines[0], /could not refresh/);
    assert.match(lines[0], /HTTP 500/);
    assert.ok(lines[0].includes(TEST_VERSION), `names the version still in use: ${lines[0]}`);
    assert.equal(lines[1], "The start text.");
    assert.match(result.calledArgs, /event-text session_start$/, "the recorded version still ran");
    assert.equal(result.recorded, TEST_VERSION);
  });

  test("an unreachable registry reads the same: the one line, then the recorded version's text", () => {
    const result = runHookWithFakeMcp("success", {
      source: "resume",
      text: "The resume text.",
      installed: true,
      registryUrl: "http://127.0.0.1:9",
    });
    assert.match(result.stdout.split("\n")[0], /could not refresh.*network error/);
    assert.equal(result.stdout.trim().split("\n").at(-1), "The resume text.");
  });

  test("with NO recorded version and the registry down, nothing runs and the one failure line says so", () => {
    registry.setMode("status-500");
    const result = runHookWithFakeMcp("success", { source: "startup", text: "must never print", installed: false });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.match(result.stdout, /Could not load the "session_start" event text/);
    assert.match(result.stdout, /HTTP 500/);
    assert.match(result.stdout, /no .* version is recorded/);
    assert.match(result.stdout, /nothing that runs it can start/);
    assert.equal(result.calledArgs, null, "the package never ran");
    assert.equal(result.npmCalls, null, "and nothing was installed");
  });

  test("a SubagentStart with no record and the registry down reports it the same way and runs nothing", () => {
    registry.setMode("status-500");
    const result = runHookWithFakeMcp("success", { event: "SubagentStart", installed: false });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Could not load the "sub_agent_start" event text/);
    assert.match(context, /nothing that runs it can start/);
    assert.equal(result.calledArgs, null);
  });

  test("a not-connected session's restart notice refreshes too, and a failed refresh adds its line only when the notice speaks", () => {
    registry.setMode("status-500");
    const spoken = runHookWithFakeMcp("success", { source: "startup", text: "Your previous session was on PLN-2.", connected: false });
    const lines = spoken.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /could not refresh.*HTTP 500/);
    assert.equal(lines[1], "Your previous session was on PLN-2.");
    const silent = runHookWithFakeMcp("empty", { source: "startup", connected: false });
    assert.equal(silent.stdout, "", "no notice to give: an unconnected session stays silent");
  });

  test("a not-connected session with no record and the registry down gets the one could-not-load line", () => {
    registry.setMode("status-500");
    const result = runHookWithFakeMcp("success", { source: "startup", connected: false, installed: false });
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.match(result.stdout, /Could not load the restart notice/);
    assert.match(result.stdout, /nothing that runs it can start/);
    assert.equal(result.calledArgs, null);
  });
});

describe("event-hook.sh — no other event is handled", () => {
  test("an unknown hook event name is a silent no-op", () => {
    const result = runHook("SomeOtherEvent", {});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});
