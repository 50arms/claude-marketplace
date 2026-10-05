#!/usr/bin/env node
// DX-4534: the Stop hook that keeps a plan session from ending its turn while its plan has
// ready cards nobody is working.
//
// WHY. The mantra (rule 1, Orchestrate) and `danxbot:plan-workflow` already require an
// orchestrating session to keep every unblocked card moving. Nothing enforced it: on
// 2026-10-04 one builder ran while two readied, unblocked cards sat untouched, because the
// session only looked for new work when a builder reported back. More prose cannot make an
// agent run a check, so the harness runs it here.
//
// WHAT IT DOES, at Claude Code's `Stop` (stdin JSON: session_id, stop_hook_active):
//   1. stop_hook_active set: this stop is already a hook-forced continuation. Allow it, so the
//      hook can never loop.
//   2. Not plan-connected (lib/plan-connection.mjs): allow, silently. Sessions with no plan are
//      untouched, and a dispatched agent never has a connection record.
//   3. Ask the recorded `danx-dashboard-mcp ready-cards` for the plan's ready cards (ToDo
//      Story/Bug/Chore with no assigned agent, no live dispatch, no block, no open problem, no
//      unmet depends_on: the subcommand's own definition, packages/danx-dashboard-mcp/src/
//      ready-cards.ts). None: allow.
//   4. Some: block the stop once, with a short reason naming the first few and one instruction
//      line. The JSON `{"decision":"block","reason":...}` on stdout is the Stop hook contract.
//   5. The read fails (dashboard down, signed out, no package): allow, and print one
//      `systemMessage` line naming the reason. The hook never blocks on its own failure.
//
// It adds no per-turn text: it prints only when it blocks or when its read failed.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinText } from "./lib/hook-input.mjs";
import { isPlanConnected, isValidSessionId } from "./lib/plan-connection.mjs";

/** Cards named in the block reason; the rest are counted, not listed. */
export const MAX_LISTED_CARDS = 5;
/** A listed title is cut to this many characters. */
export const MAX_TITLE_CHARS = 80;
/** The `ready-cards` read's own budget: its request timeout is 5s, this sits above it. */
export const READY_CARDS_TIMEOUT_MS = 12_000;

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The hook JSON on stdin, or `{}` when it is absent or unparseable (the env session id still applies). */
export function parseStopPayload(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function truncate(title) {
  const points = Array.from(title.replace(/\s+/g, " ").trim());
  return points.length > MAX_TITLE_CHARS ? `${points.slice(0, MAX_TITLE_CHARS).join("")}…` : points.join("");
}

/** The block reason for `cards` ([{id, title}], at least one). */
export function blockReason(cards) {
  const listed = cards.slice(0, MAX_LISTED_CARDS).map((c) => `${c.id} ${truncate(c.title)}`);
  const more = cards.length > listed.length ? `, and ${cards.length - listed.length} more` : "";
  return (
    `Your plan has ${cards.length} ready, unblocked card${cards.length === 1 ? "" : "s"} nobody is working: ${listed.join("; ")}${more}. ` +
    "Dispatch each now, or record on the card why it cannot run (dependency, problem, block)."
  );
}

/** The `ready-cards` subcommand's stdout as `{cards}`, or null when it is not the contract's one JSON line. */
export function parseReadyCards(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed?.cards)) return null;
    if (!parsed.cards.every((c) => typeof c?.id === "string" && typeof c?.title === "string")) return null;
    return parsed.cards;
  } catch {
    return null;
  }
}

/** One line from a failed child's stderr, or a fallback naming how it ended. */
function failureLine(result, what) {
  if (result.error) return `${what}: ${result.error.code === "ETIMEDOUT" ? "timeout" : result.error.message}`;
  const firstLine = String(result.stderr ?? "").split("\n").find((l) => l.trim() !== "");
  return firstLine ? firstLine.trim() : `${what}: exit_${result.status} with no message`;
}

/**
 * What the hook answers: `{}` to allow silently, `{decision:"block", reason}` to block, or
 * `{systemMessage}` to allow with one line naming why the read failed. `run` is the child
 * runner (a test seam).
 */
export function decide({ payload, env = process.env, run = spawnSync }) {
  if (payload.stop_hook_active === true) return {};
  const sessionId = typeof payload.session_id === "string" && payload.session_id !== "" ? payload.session_id : (env.CLAUDE_CODE_SESSION_ID ?? null);
  if (!isValidSessionId(sessionId)) return {};
  if (!isPlanConnected(sessionId, env.DANXBOT_PLAN_SESSIONS_HOME || undefined)) return {};

  const skipped = (reason) => ({ systemMessage: `danxbot ready-cards check skipped (the stop is allowed): ${reason}` });
  const childOptions = { encoding: "utf8", timeout: READY_CARDS_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };

  const ensured = run("bash", [path.join(pluginRoot, "scripts", "ensure-dashboard-mcp.sh")], { ...childOptions, env });
  if (ensured.error || ensured.status !== 0) return skipped(failureLine(ensured, "dashboard_mcp_unavailable"));
  const bin = String(ensured.stdout).trim();

  const read = run(process.execPath, [bin, "ready-cards"], { ...childOptions, env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId } });
  if (read.error || read.status !== 0) return skipped(failureLine(read, "ready_cards_failed"));
  const cards = parseReadyCards(String(read.stdout));
  if (cards === null) return skipped("bad_response: ready-cards did not print its JSON line");
  if (cards.length === 0) return {};
  return { decision: "block", reason: blockReason(cards) };
}

async function main() {
  const payload = parseStopPayload(await readStdinText());
  const answer = decide({ payload });
  if (Object.keys(answer).length > 0) process.stdout.write(`${JSON.stringify(answer)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      // Never block, never fail a turn, on the hook's own bug.
      process.stdout.write(`${JSON.stringify({ systemMessage: `danxbot ready-cards check skipped (the stop is allowed): fatal: ${err.message}` })}\n`);
      process.exit(0);
    },
  );
}
