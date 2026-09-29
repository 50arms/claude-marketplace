#!/usr/bin/env node
//
// measure-injection.mjs — DX-3053.
//
// Prints the full table of what every enabled plugin's hooks inject into a
// session: per plugin, per hook entry, per event it is registered for, with
// byte counts, and totals per cadence class (per-turn / per-session /
// per-tool-call). This is the harness DX-3049's manual `| wc -c` inventory
// was built with by hand; this script reproduces those numbers on demand.
//
// WHY A REAL HARNESS AND NOT A HAND COUNT (DX-3053 AC)
// ------------------------------------------------------
// Every hook script here starts with `set -euo pipefail`. Running one with
// CLAUDE_PLUGIN_ROOT unset makes an unbound-variable expansion abort it
// before it reaches its event branch — it emits zero bytes and silently
// LOOKS like a hook that injects nothing. This harness sets CLAUDE_PLUGIN_ROOT
// to the real plugin directory for every invocation, exactly as Claude Code's
// own hook runner does, so a hook that would abort here would also abort in
// a real session — never the other way around (AC: "the harness sets
// CLAUDE_PLUGIN_ROOT per script").
//
// WHAT COUNTS AS "UNCONDITIONAL" VS "CONDITIONAL"
// -------------------------------------------------
// UserPromptSubmit hooks are run TWICE: once with a plain, non-triggering
// prompt, and once with a single composite prompt built to trip every known
// conditional gate at once. DX-3235 removed the last two vocabulary-triggered
// per-turn gates (debugging-gate.sh's "why"/"investigate"/"audit" regex and
// human-loop-mandate.sh's "?" check) — a per-turn gate cannot tell a
// background task notification from an operator prompt, so both fired on
// agent report text. No UserPromptSubmit hook is conditional today; the two
// runs stay so a future one is classified, never summed. A hook whose plain-prompt
// byte count is 0 and whose trigger-prompt
// count is >0 is conditional; its plain-prompt (0) count is what's added to
// the unconditional per-turn total, and its trigger count is reported
// alongside, never summed into the unconditional total (AC 32509).
//
// PostToolUse groups with a real matcher (not ".*"/null) are run with a
// representative tool_name drawn from the FIRST alternative in the matcher's
// own regex, so a matched-only hook (e.g. plan-note-reminder.mjs) is
// measured at the byte count it actually emits when it fires, not guessed.
//
// CADENCE TOTALS (AC 32510)
// ---------------------------
// Reported separately, never summed together:
//   - per-turn      = UserPromptSubmit, unconditional (plain-prompt) bytes
//   - per-session    = SessionStart, every hook whose matcher fires at an
//                       ordinary session startup (no matcher, or a matcher
//                       that names "startup" — DX-3347's mantra.sh is the
//                       first hook to combine a real matcher with firing
//                       at startup; see matchesSource())
//   - per-tool-call  = PostToolUse, hooks with NO matcher or a ".*" matcher
//                       (fire on literally every tool call)
//
// USAGE
//   node scripts/measure-injection.mjs [--json]
//
// Exit 0 always (this is a report, not a gate — scripts/publish.sh is the
// gate and imports the per-turn total from --json output).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MODE = process.argv.includes("--json");

// Composite trigger prompt: a question plus a plan URL, the shapes past
// conditional UserPromptSubmit hooks keyed on (none remains — see above).
const TRIGGER_PROMPT =
  "Why is this failing? See https://danxbot.sageus.ai/plans/11 for context.";
const PLAIN_PROMPT = "Please rename this variable to something clearer.";

const SESSION_START_MATCHER_SOURCE = {
  compact: "compact",
  "startup|resume|clear|compact": "startup",
};

function loadMarketplacePlugins() {
  const mpPath = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
  const mp = JSON.parse(fs.readFileSync(mpPath, "utf8"));
  return mp.plugins.map((p) => p.source.replace(/^\.\//, ""));
}

function loadHooksJson(pluginDir) {
  const hooksPath = path.join(REPO_ROOT, pluginDir, "hooks", "hooks.json");
  if (!fs.existsSync(hooksPath)) return null;
  return JSON.parse(fs.readFileSync(hooksPath, "utf8"));
}

// Split a single hooks.json "hooks" array entry's `command` string into
// its constituent single-invocation commands. hooks.json always lists one
// invocation per array element already (unlike the human-readable pipe-
// joined summaries elsewhere), so this is the array itself — no splitting
// needed. Kept as a named step so the shape is documented once.
function commandsForGroup(group) {
  return (group.hooks || []).map((h) => h.command);
}

// Does a SessionStart hook group fire for a given `source` value
// ("startup" | "resume" | "clear" | "compact" | "fork")? No matcher (or a
// wildcard) means "every source" — DX-3053: matcher=null used to be the
// ONLY shape a session-start hook took, so summarize() originally treated
// "no matcher" as the entire per-session-start bucket. DX-3347 introduced
// mantra.sh with an explicit matcher ("startup|resume|compact") that STILL
// fires at ordinary session start — a hook with a matcher is not the same
// thing as a hook that never fires at startup. Without this check,
// summarize()'s perSession total silently dropped mantra.sh's 3,709 bytes
// (22,664B measured vs the real 26,373B DX-3347 itself reported) — the
// exact "under-report" failure mode AC 32508 already guards for
// CLAUDE_PLUGIN_ROOT, now shown up again one layer higher, in how a
// matcher is read rather than in whether the process aborts.
function matchesSource(matcher, source) {
  if (!matcher || matcher === ".*" || matcher === "*") return true;
  return matcher.split("|").includes(source);
}

// Representative tool_name for a matcher regex — first `|`-delimited
// alternative found inside it, stripped of anchors/groups. Falls back to
// "Bash" for a matcher this can't parse (never silently skips a group).
function representativeToolName(matcher) {
  if (!matcher || matcher === ".*" || matcher === "*") return "Bash";
  const inner = matcher.replace(/^\^\(?/, "").replace(/\)?\$$/, "");
  const first = inner.split("|")[0];
  return first || "Bash";
}

function freshSessionId() {
  // A fresh session_id per invocation — several hooks (inject-time.sh)
  // keep per-session state on disk (e.g. /tmp/claude-time-hook-<sid>) so a
  // reused id lets one measurement's state leak into the next one's byte
  // count. Every row gets its own id so every measurement is a fresh
  // first-fire, matching DX-3049's manual baseline.
  // DX-3384 (comment 7550): unique across RUNS too, not just within one. The
  // old `<pid>-<counter>` id collided when a PID recycled (routine under Git
  // Bash), so a stale state file from an earlier run turned inject-time.sh's
  // "+0" into "+12h 34m 56s" and the baseline read 4448 instead of 4438.
  return `measure-injection-${randomUUID()}`;
}

function stdinFor(event, matcher) {
  const base = { session_id: freshSessionId(), cwd: REPO_ROOT };
  switch (event) {
    case "UserPromptSubmit":
      return (prompt) => JSON.stringify({ ...base, prompt });
    case "SessionStart": {
      const source = SESSION_START_MATCHER_SOURCE[matcher] || "startup";
      return () => JSON.stringify({ ...base, source });
    }
    case "PostToolUse": {
      const toolName = representativeToolName(matcher);
      return () =>
        JSON.stringify({
          ...base,
          tool_name: toolName,
          tool_input: {},
          tool_response: { success: true },
        });
    }
    case "PreToolUse": {
      const toolName = representativeToolName(matcher);
      return () =>
        JSON.stringify({ ...base, tool_name: toolName, tool_input: { command: "echo hi" } });
    }
    case "Stop":
    case "SessionEnd":
      return () => JSON.stringify({ ...base, reason: "measure-injection" });
    default:
      return () => JSON.stringify(base);
  }
}

function runCommand(pluginDir, command, stdinPayload) {
  const pluginRoot = path.join(REPO_ROOT, pluginDir);
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  };
  try {
    const out = execFileSync("bash", ["-c", command], {
      cwd: REPO_ROOT,
      env,
      input: stdinPayload,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { bytes: out.length, error: null };
  } catch (err) {
    // A non-zero exit or timeout is reported as an error row, never
    // silently folded into "0 bytes" — a genuine abort and a genuine
    // empty-conditional-output must stay distinguishable.
    return { bytes: err.stdout ? err.stdout.length : 0, error: err.message.split("\n")[0] };
  }
}

function measure() {
  const plugins = loadMarketplacePlugins();
  const rows = []; // { plugin, event, matcher, command, kind, bytes, triggerBytes, error }

  for (const plugin of plugins) {
    const hooksJson = loadHooksJson(plugin);
    if (!hooksJson) continue;
    for (const [event, groups] of Object.entries(hooksJson.hooks || {})) {
      for (const group of groups) {
        const matcher = group.matcher || null;
        const commands = commandsForGroup(group);
        const stdinBuilder = stdinFor(event, matcher);
        for (const command of commands) {
          if (event === "UserPromptSubmit" && !matcher) {
            const plain = runCommand(plugin, command, stdinBuilder(PLAIN_PROMPT));
            const triggered = runCommand(plugin, command, stdinBuilder(TRIGGER_PROMPT));
            rows.push({
              plugin,
              event,
              matcher,
              command,
              kind: plain.bytes === 0 && triggered.bytes > 0 ? "conditional" : "unconditional",
              bytes: plain.bytes,
              triggerBytes: triggered.bytes,
              error: plain.error || triggered.error || null,
            });
          } else {
            const result = runCommand(plugin, command, stdinBuilder());
            const unmatchedEveryCall =
              event === "PostToolUse" && (!matcher || matcher === ".*");
            rows.push({
              plugin,
              event,
              matcher,
              command,
              kind: unmatchedEveryCall
                ? "every-tool-call"
                : matcher
                ? "matched"
                : "unconditional",
              bytes: result.bytes,
              triggerBytes: null,
              error: result.error,
            });
          }
        }
      }
    }
  }
  return rows;
}

function summarize(rows) {
  const perTurnUnconditional = rows
    .filter((r) => r.event === "UserPromptSubmit" && r.kind === "unconditional")
    .reduce((sum, r) => sum + r.bytes, 0);

  const perSession = rows
    .filter((r) => r.event === "SessionStart" && matchesSource(r.matcher, "startup"))
    .reduce((sum, r) => sum + r.bytes, 0);

  const perToolCall = rows
    .filter((r) => r.event === "PostToolUse" && r.kind === "every-tool-call")
    .reduce((sum, r) => sum + r.bytes, 0);

  return { perTurnUnconditional, perSession, perToolCall };
}

function printHuman(rows, totals) {
  const scriptName = (cmd) => cmd.split("/").pop().split(" ")[0];
  console.log("Injection measurement (CLAUDE_PLUGIN_ROOT set per script; plain + trigger prompts for UserPromptSubmit)\n");
  const byEvent = {};
  for (const r of rows) {
    (byEvent[r.event] ||= []).push(r);
  }
  for (const [event, evRows] of Object.entries(byEvent)) {
    console.log(`=== ${event} ===`);
    for (const r of evRows) {
      const tag = r.error ? ` [ERROR: ${r.error}]` : "";
      const trig = r.triggerBytes != null ? `, trigger=${r.triggerBytes}` : "";
      console.log(
        `  ${r.plugin.padEnd(20)} ${scriptName(r.command).padEnd(32)} matcher=${String(r.matcher).padEnd(18)} kind=${r.kind.padEnd(14)} bytes=${r.bytes}${trig}${tag}`
      );
    }
    console.log("");
  }
  console.log("=== Totals (never summed together — different cadences) ===");
  console.log(`  per-turn (UserPromptSubmit, unconditional):      ${totals.perTurnUnconditional} bytes`);
  console.log(`  per-session (SessionStart, no-matcher group):    ${totals.perSession} bytes`);
  console.log(`  per-tool-call (PostToolUse, every-call hooks):   ${totals.perToolCall} bytes`);
}

const rows = measure();
const totals = summarize(rows);

if (JSON_MODE) {
  console.log(JSON.stringify({ rows, totals }, null, 2));
} else {
  printHuman(rows, totals);
}

const hadError = rows.some((r) => r.error);
process.exit(hadError ? 1 : 0);
