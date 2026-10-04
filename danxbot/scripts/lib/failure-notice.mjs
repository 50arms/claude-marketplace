/**
 * The ONE wording for a failure a session could not otherwise see, shared by
 * `plan-event-bridge.mjs` (which posts it into the session's inbox or prints it
 * for `asyncRewake`) and `bridge-watchdog.mjs` (DX-3997: which must not import
 * the bridge, so neither can own this).
 */

/**
 * The one short tag every machine-posted bridge message starts with, so the session knows
 * what kind of message it is. Everything about HOW to handle these messages lives in
 * danxbot:plan-workflow's "Live events" section, never repeated per message (operator,
 * 2026-09-27: a bridge message can arrive dozens of times a session). The inbox delivers
 * it as a user turn and no hook-input field identifies a message's source, so content is
 * the only marker available. No other plugin reads this literal since DX-3235.
 */
export const RELAY_MARKER = "[danxbot plan event]";

/** Prefix of every bridge failure notice. */
export const FAILURE_PREFIX = `${RELAY_MARKER} bridge down:`;

/**
 * DX-2862 — the ONE wording for a failure a session could not otherwise see.
 * Every path that ends a bridge without events flowing goes through this, so a
 * session is never left to infer silence from the absence of messages.
 */
export function failureNotice(reason, fix) {
  const trim = (text) => String(text ?? "").trim().replace(/\.+$/, "");
  return (
    `${FAILURE_PREFIX} events are NOT reaching this session: ${trim(reason)}. ` +
    `Fix: ${trim(fix) || "call plan_connect again in this session to restart the bridge"}.`
  );
}

/**
 * DX-4321 — the notice for a session start whose refresh of the recorded danx-dashboard-mcp
 * version failed. The bridge is NOT down (it runs the recorded version), so this is not a
 * failureNotice: `line` is the one line the version module wrote, naming the reason and the
 * version still in use.
 */
export function versionKeptNotice(line) {
  return `${RELAY_MARKER} ${String(line ?? "").trim().replace(/\.+$/, "")}. Events keep flowing on that version; tell the operator if the registry stays unreachable.`;
}
