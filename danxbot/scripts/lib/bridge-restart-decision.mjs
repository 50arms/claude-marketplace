/**
 * DX-2953 / DX-3997 — the watchdog's restart decision, pure (no fs, no clock
 * besides the injected `now`), shared by `bridge-watchdog.mjs` (which decides)
 * and `plan-event-bridge.mjs` (whose `buildStartedRecord` bumps the same
 * generation counter on a watchdog-triggered start).
 *
 * Lives outside the bridge so the code that restarts a dead bridge never
 * depends on the bridge file being intact.
 */

import { HEARTBEAT_STALE_MS, HEALTHY_RUN_MS } from "./bridge-state.mjs";

/**
 * DX-2953 — stop reasons that ALWAYS forbid a watchdog restart, regardless
 * of `restartGeneration` or `consumedStopInstance`: the session is either
 * definitively not connected (DX-4391: or signed out, its session key gone, which only a new
 * `plan_connect` approval fixes), or another listener already has (or will) cover it.
 * `bridge_failed` is handled separately (see
 * `shouldWatchdogRestart`) — it forbids a restart only once already
 * consumed, or while `restartGeneration` has not reset.
 */
export const FORBID_RESTART_ALWAYS = new Set(["no_connection_record", "credential_unavailable", "not_connected", "superseded", "replaced", "session_is_worker"]);

/**
 * DX-2953 — the crash-loop guard: how many watchdog-triggered restarts this
 * "unhealthy streak" has already spent. `.started.json`'s `restartGeneration`
 * is a literal, start()-written integer (single-writer, per the card), but
 * ITS RESET is computed lazily here rather than written by a third party
 * (which the two-marker design forbids): once the CURRENT `lastStartedInstance`
 * has been alive at least HEALTHY_RUN_MS — measured from `startedAt` to
 * either its OWN applicable stop record's `recordedAt` (it died, but lived
 * long enough first) or `now` (it might still be alive/healthy right now) —
 * the streak is over and the effective generation reads as 0, even though
 * the stored value stays whatever it was until the NEXT `start()` call
 * persists the collapsed value (the sole writer catching up on its own next
 * write). Mirrors `classifyChildExit`'s existing `ranMs >= HEALTHY_RUN_MS`
 * pattern for the analogous subcommand-restart decision.
 */
export function effectiveRestartGeneration({ startedRecord, stoppedRecord = null, now, healthyRunMs = HEALTHY_RUN_MS }) {
  const stored = startedRecord?.restartGeneration ?? 0;
  if (stored <= 0) return 0;
  const startedAt = Date.parse(startedRecord?.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return stored;
  const appliesToCurrent = stoppedRecord && stoppedRecord.writingInstanceId === startedRecord.lastStartedInstance;
  const recordedAt = appliesToCurrent ? Date.parse(stoppedRecord.recordedAt ?? "") : NaN;
  const ranUntil = Number.isFinite(recordedAt) ? recordedAt : now;
  return ranUntil - startedAt >= healthyRunMs ? 0 : stored;
}

/** A `.pid.json` record the watchdog considers stale: missing, or heartbeatAt older than heartbeatStaleMs. */
export function isMarkerStale({ pidRecord, now, heartbeatStaleMs = HEARTBEAT_STALE_MS }) {
  if (!pidRecord) return true;
  const heartbeatAt = Date.parse(pidRecord.heartbeatAt ?? "");
  if (!Number.isFinite(heartbeatAt)) return true;
  return now - heartbeatAt > heartbeatStaleMs;
}

/**
 * DX-2953 — the watchdog's whole restart decision, pure (no fs, no clock
 * besides the injected `now`) so every branch in the card's checklist is
 * unit-tested without a spawned process. Reads exactly the four inputs the
 * card names: `.pid.json` (staleness), `.started.json` (`lastStartedInstance`
 * / `restartGeneration` / `consumedStopInstance`), `.connected.json`
 * (whether this session is known to want a bridge at all), and
 * `.stopped.json` (why the last one ended) — NEVER the stopped record's
 * `paths` field, which is the live child's own watched-path retry input,
 * not the watchdog's concern.
 *
 * Matches a stop record to the CURRENT instance on `writingInstanceId` ONLY
 * — never `instanceId`, which `bridge.ts` stamps independently and which
 * silently drifts to a fresh `randomUUID()` there on its own (see
 * `resolveInstanceId` in `bridge.ts`, and the module docblock's drift
 * section). A record from any other (superseded) instance is not
 * "applicable" and never forbids or gates anything.
 */
export function shouldWatchdogRestart({ pidRecord, startedRecord, connectedRecord, stoppedRecord, now, heartbeatStaleMs = HEARTBEAT_STALE_MS }) {
  if (!connectedRecord || connectedRecord.connected !== true) {
    return { restart: false, reason: "this session is not known to be connected to a plan" };
  }
  if (!isMarkerStale({ pidRecord, now, heartbeatStaleMs })) {
    return { restart: false, reason: "the bridge is not stale" };
  }
  const lastStartedInstance = startedRecord?.lastStartedInstance ?? null;
  const applicable = stoppedRecord && lastStartedInstance && stoppedRecord.writingInstanceId === lastStartedInstance ? stoppedRecord : null;
  if (applicable) {
    if (FORBID_RESTART_ALWAYS.has(applicable.reason)) {
      return { restart: false, reason: `an applicable stop record forbids a restart: ${applicable.reason}` };
    }
    if (applicable.reason === "bridge_failed") {
      const consumedInstance = applicable.writingInstanceId;
      if (startedRecord?.consumedStopInstance === consumedInstance) {
        return { restart: false, reason: "this bridge_failed record was already consumed by an earlier watchdog restart" };
      }
      if (effectiveRestartGeneration({ startedRecord, stoppedRecord, now }) > 0) {
        return { restart: false, reason: "restartGeneration has not reset since the last watchdog restart" };
      }
      return { restart: true, reason: `restarting after bridge_failed: ${applicable.detail}`, consumeStopInstance: consumedInstance };
    }
    // Every other applicable reason (a degraded reason left by a bridge
    // killed while degraded, revoked, refused, scope_narrowed, ...) does not
    // forbid a restart on its own — see the module docblock's "restart
    // decision reads the stop record" section.
  }
  if (effectiveRestartGeneration({ startedRecord, stoppedRecord, now }) > 0) {
    return { restart: false, reason: "restartGeneration has not reset since the last watchdog restart" };
  }
  return {
    restart: true,
    reason: applicable ? `restarting: an applicable stop record (${applicable.reason}) does not forbid it` : "the bridge is stale with no applicable stop record",
  };
}
