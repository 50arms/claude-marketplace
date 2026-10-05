// DX-4534: ready-cards-stop.mjs, the Stop hook that blocks a plan session's stop once while its
// plan has ready, unclaimed cards. The real script runs as a process over a FAKE installed
// danx-dashboard-mcp (fixtures/fake-dashboard-mcp.mjs), so nothing here touches the network.
//
// Run with `npm test` (node --test, no dependencies).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeNpm, installFakeMcp, makeFakeBinDir, recordVersion } from "./fixtures/fake-dashboard-mcp.mjs";
import { MAX_LISTED_CARDS, MAX_TITLE_CHARS, blockReason, parseReadyCards } from "../scripts/ready-cards-stop.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(here, "..");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "ready-cards-stop.mjs");
const HOOKS_JSON = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));

const SESSION = "plan-session-1";

/**
 * Runs the hook for `payload`. `mode` is the fake bin's FAKE_MCP_MODE, `text` its stdout; `connected`
 * writes the session's plan-connection record; `installed: false` leaves the data dir without a bin.
 */
function runHook({ payload = { session_id: SESSION }, mode = "success", text = "", stderrText = "", connected = true, installed = true } = {}) {
  const fakeBinDir = makeFakeBinDir({ npm: fakeNpm() });
  const home = mkdtempSync(path.join(tmpdir(), "ready-cards-home-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "ready-cards-data-"));
  const argsFile = path.join(dataDir, "args.txt");
  try {
    if (connected) {
      const dir = path.join(home, ".config", "danxbot", "plan-sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify({ schemaVersion: 3 }));
    }
    // Not installed: a version is recorded (so no registry lookup) but only a failing fake `npm` can install it.
    if (installed) installFakeMcp(dataDir);
    else recordVersion(dataDir);
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
        FAKE_NPM_MODE: "unreachable",
        FAKE_NPM_CALLS_FILE: path.join(fakeBinDir, "npm-calls.txt"),
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        CLAUDE_PLUGIN_DATA: dataDir,
        DANXBOT_PLAN_SESSIONS_HOME: home,
        FAKE_MCP_MODE: mode,
        FAKE_MCP_TEXT: text,
        FAKE_MCP_STDERR: stderrText,
        FAKE_MCP_ARGS_FILE: argsFile,
      },
    });
    let calledArgs = null;
    try {
      calledArgs = readFileSync(argsFile, "utf8").trim();
    } catch {
      // the fake never ran
    }
    return { ...result, calledArgs };
  } finally {
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const readyLine = (cards) => `${JSON.stringify({ plan_id: 11, cards })}\n`;
const card = (n) => ({ id: `DX-${n}`, title: `Card ${n}` });

describe("ready-cards-stop.mjs: blocks the stop once when the plan has ready cards", () => {
  test("lists the ready cards (id and title) with the dispatch-or-record instruction, as a Stop block decision", () => {
    const result = runHook({ text: readyLine([card(4470), card(4514)]) });
    assert.equal(result.status, 0);
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.decision, "block");
    assert.match(answer.reason, /2 ready, unblocked cards nobody is working: DX-4470 Card 4470; DX-4514 Card 4514\./);
    assert.match(answer.reason, /Dispatch each now, or record on the card why it cannot run \(dependency, problem, block\)\./);
    assert.deepEqual(Object.keys(answer).sort(), ["decision", "reason"]);
  });

  test("asks the recorded package's ready-cards subcommand, with no arguments", () => {
    const result = runHook({ text: readyLine([card(1)]) });
    assert.equal(result.calledArgs, "ready-cards");
  });

  test("a single card reads as singular", () => {
    const answer = JSON.parse(runHook({ text: readyLine([card(7)]) }).stdout);
    assert.match(answer.reason, /^Your plan has 1 ready, unblocked card nobody is working: DX-7 Card 7\./);
  });
});

describe("ready-cards-stop.mjs: allows the stop silently", () => {
  test("stop_hook_active set (the stop is already a hook-forced continuation): no output, and the read never runs", () => {
    const result = runHook({ payload: { session_id: SESSION, stop_hook_active: true }, text: readyLine([card(1)]) });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.calledArgs, null);
  });

  test("no plan connected: no output, and the read never runs", () => {
    const result = runHook({ connected: false, text: readyLine([card(1)]) });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.calledArgs, null);
  });

  test("a session id that is not a safe path segment is never connected", () => {
    const result = runHook({ payload: { session_id: "../x" }, text: readyLine([card(1)]) });
    assert.equal(result.stdout, "");
    assert.equal(result.calledArgs, null);
  });

  test("no ready card: no output", () => {
    const result = runHook({ text: readyLine([]) });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

describe("ready-cards-stop.mjs: a failed read allows the stop and names the reason on one line", () => {
  function assertSkipped(result, reasonPattern) {
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const answer = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(answer), ["systemMessage"]);
    assert.match(answer.systemMessage, /^danxbot ready-cards check skipped \(the stop is allowed\): /);
    assert.match(answer.systemMessage, reasonPattern);
  }

  test("the subcommand exits 1 (dashboard down, signed out): its stderr reason is named", () => {
    assertSkipped(runHook({ mode: "fail", stderrText: "request_failed: could not read the plan's ready cards from the dashboard" }), /request_failed/);
  });

  test("the subcommand exits non-zero with no message: the exit code is named", () => {
    assertSkipped(runHook({ mode: "silent-fail" }), /ready_cards_failed: exit_3/);
  });

  test("the subcommand prints something that is not its JSON line", () => {
    assertSkipped(runHook({ text: "not json" }), /bad_response/);
  });

  test("the subcommand prints cards of the wrong shape", () => {
    assertSkipped(runHook({ text: `${JSON.stringify({ plan_id: 1, cards: [{ id: 5 }] })}\n` }), /bad_response/);
  });

  test("no installed package and no way to install it: the ensure step's reason is named", () => {
    assertSkipped(runHook({ installed: false }), /dashboard_mcp_unavailable|npm|install/i);
  });
});

describe("blockReason / parseReadyCards", () => {
  test("lists at most MAX_LISTED_CARDS and counts the rest", () => {
    const cards = Array.from({ length: MAX_LISTED_CARDS + 3 }, (_, i) => card(i + 1));
    const reason = blockReason(cards);
    assert.match(reason, new RegExp(`^Your plan has ${cards.length} ready`));
    assert.match(reason, new RegExp(`DX-${MAX_LISTED_CARDS} Card ${MAX_LISTED_CARDS}, and 3 more\\.`));
    assert.ok(!reason.includes(`DX-${MAX_LISTED_CARDS + 1} `));
  });

  test("a long title is cut and a multi-line one is flattened, so the reason stays one short paragraph", () => {
    const reason = blockReason([{ id: "DX-9", title: `${"x".repeat(MAX_TITLE_CHARS + 20)}\nsecond line` }]);
    assert.ok(!reason.includes("\n"));
    assert.ok(reason.includes(`${"x".repeat(MAX_TITLE_CHARS)}…`));
    assert.ok(!reason.includes("second line"));
  });

  test("parseReadyCards accepts the contract line and refuses anything else", () => {
    assert.deepEqual(parseReadyCards(readyLine([card(1)])), [card(1)]);
    assert.equal(parseReadyCards("{}"), null);
    assert.equal(parseReadyCards(""), null);
  });
});

describe("hooks.json wiring", () => {
  const stopHooks = HOOKS_JSON.hooks.Stop.flatMap((group) => group.hooks);
  const entry = stopHooks.find((h) => h.command.includes("ready-cards-stop.mjs"));

  test("Stop runs it through the integrity launcher, synchronously (a block must be read before the stop), with room for the read", () => {
    assert.ok(entry, "no Stop hook runs ready-cards-stop.mjs");
    assert.match(entry.command, /launch\.mjs" scripts\/ready-cards-stop\.mjs$/);
    assert.notEqual(entry.async, true);
    assert.equal(entry.asyncRewake, undefined);
    assert.ok(entry.timeout >= 20, "the timeout must outlast the subcommand's own read budget");
  });

  test("it is wired to Stop only", () => {
    for (const [event, groups] of Object.entries(HOOKS_JSON.hooks)) {
      if (event === "Stop") continue;
      assert.ok(!JSON.stringify(groups).includes("ready-cards-stop"), `${event} must not run it`);
    }
  });
});
