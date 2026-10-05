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
//   1. No usable stdin JSON, or stop_hook_active set: allow, silently. Without the payload the
//      hook cannot tell whether this stop is already a hook-forced continuation, so it never
//      guesses (and never reads the ambient session id instead); with it set, the hook can
//      never loop.
//   2. Not plan-connected (lib/plan-connection.mjs): allow, silently. Sessions with no plan are
//      untouched, and a dispatched agent never has a connection record.
//   3. Ask the recorded `danx-dashboard-mcp ready-cards` for the plan's ready cards (ToDo
//      Story/Bug/Chore with no assigned agent, no live dispatch, no block, no open problem, no
//      unmet depends_on: the subcommand's own definition, packages/danx-dashboard-mcp/src/
//      ready-cards.ts). None: allow.
//   4. Some: block the stop once, with a short reason naming the first few and one instruction
//      line. The JSON `{"decision":"block","reason":...}` on stdout is the Stop hook contract.
//   5. The read fails: allow. A signed-out or keyless session (EXPECTED_REASONS: the same two
//      reasons event-hook.sh and activity-report.mjs treat as ordinary) says nothing; any other
//      failure prints one `systemMessage` line naming the reason. The hook never blocks on its
//      own failure.
//
// It adds no per-turn text: it prints only when it blocks or when its read failed.
//
// ONE TIME BUDGET: the install check (ensureInstalled, a file check once installed) gets
// ENSURE_TIMEOUT_MS and the read READ_TIMEOUT_MS, so a stop never waits longer than
// READY_CARDS_TIMEOUT_MS plus node's own start; hooks.json's `timeout` sits above it.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinText } from "./lib/hook-input.mjs";
import { isPlanConnected, isValidSessionId } from "./lib/plan-connection.mjs";
import { ensureInstalled } from "./activity-report.mjs";
import { childEnv } from "./plan-event-bridge.mjs";

/** Cards named in the block reason; the rest are counted, not listed. */
export const MAX_LISTED_CARDS = 5;
/** A listed title is cut to this many characters. */
export const MAX_TITLE_CHARS = 80;
/** The install check's budget. */
export const ENSURE_TIMEOUT_MS = 3_000;
/** The `ready-cards` read's budget: a plan read, then its boards in parallel. */
export const READ_TIMEOUT_MS = 5_000;
/** Everything one stop can spend in child processes. */
export const READY_CARDS_TIMEOUT_MS = ENSURE_TIMEOUT_MS + READ_TIMEOUT_MS;

/** Failures that are the ordinary answer for a session with no usable dashboard sign-in: the hook says nothing. */
export const EXPECTED_REASONS = new Set(["no_connection_record", "credential_unavailable"]);

const SKIPPED_PREFIX = "danxbot ready-cards check skipped (the stop is allowed): ";

/** The allow-with-one-line answer naming why the read failed. */
export function skipped(reason) {
  return { systemMessage: `${SKIPPED_PREFIX}${reason}` };
}

/** The hook JSON on stdin as an object, or null when it is absent, unparseable or not an object. */
export function parseStopPayload(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
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

/** The subcommand's stdout as its card list, or null when it is not the contract's one JSON line. */
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

/** The first stderr line of a failed read: its reason is the text before the first colon (the subcommand's contract). */
export function readFailure(result) {
  if (result.error) return { reason: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn_error", line: `ready_cards_failed: ${result.error.code === "ETIMEDOUT" ? "timeout" : result.error.message}` };
  const line = String(result.stderr ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? `ready_cards_failed: exit_${result.status} with no message`;
  return { reason: line.split(":")[0], line };
}

/**
 * What the hook answers: `{}` to allow silently, `{decision:"block", reason}` to block, or
 * `{systemMessage}` to allow with one line naming why the read failed. `run` and `ensure` are
 * test seams.
 */
export function decide({ payload, env = process.env, run = spawnSync, ensure = ensureInstalled }) {
  if (payload === null || payload.stop_hook_active === true) return {};
  const sessionId = payload.session_id;
  if (!isValidSessionId(sessionId)) return {};
  if (!isPlanConnected(sessionId, env.DANXBOT_PLAN_SESSIONS_HOME || undefined)) return {};

  const ensured = ensure({ env, timeoutMs: ENSURE_TIMEOUT_MS });
  if (!ensured.ok) return skipped(ensured.reason);

  const read = run(process.execPath, [ensured.bin, "ready-cards"], {
    env: childEnv(env, sessionId),
    encoding: "utf8",
    timeout: READ_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (read.error || read.status !== 0) {
    const failure = readFailure(read);
    return EXPECTED_REASONS.has(failure.reason) ? {} : skipped(failure.line);
  }
  const cards = parseReadyCards(String(read.stdout));
  if (cards === null) return skipped("bad_response: ready-cards did not print its JSON line");
  if (cards.length === 0) return {};
  return { decision: "block", reason: blockReason(cards) };
}

async function main() {
  const answer = decide({ payload: parseStopPayload(await readStdinText()) });
  if (Object.keys(answer).length > 0) process.stdout.write(`${JSON.stringify(answer)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err) => {
      // Never block, never fail a turn, on the hook's own bug.
      process.stdout.write(`${JSON.stringify(skipped(`fatal: ${err.message}`))}\n`);
      process.exit(0);
    },
  );
}
