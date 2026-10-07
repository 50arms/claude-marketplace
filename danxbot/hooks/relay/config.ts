import type { RelayState } from '../../types'

// DX-4233: the plan event relay's constants. The relay is the module's own loop on the session's danx-dashboard MCP server's
// `plan_events_wait` tool (PLAN-23, "Event relay in-process"): no spawned process, no state file.

// The tag every relayed row starts with, so the model knows what kind of message it is. How to handle each kind lives in
// danxbot:plan-workflow's "Live events", never repeated per message. No hook field names a row's source, so the text is the marker.
export const RELAY_MARKER = '[danxbot plan event]'

export const RELAY_TOOL = 'plan_events_wait'

// One call waits this long on the server for an event (the server's contract: 1000..30000). Short, so a call orphaned by a
// plugin reload ends fast on the server.
export const WAIT_MS = 20_000

// The wait before a retry of a failed call, one schedule for every failure (the last step repeats). The server keeps heartbeating the
// dashboard for 40 s after the last call it saw (HEARTBEAT_ACTIVITY_WINDOW_MS in danxbot's
// packages/danx-dashboard-mcp/src/plan-events-relay.ts) and a pending call counts as activity, so the longest gap between two calls is the
// largest step here plus a turnaround: far inside that window. A dead or unloaded module reads not-healthy once the window passes.
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const

// The wait before try number `failures` (1 for the first): the schedule's last step repeats.
export function backoffMs(failures: number): number {
  return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1]
}

// DX-4233: the light read of the session's plan that starts a relay at session start (and by the watchdog) answers within this or is a failure.
export const RELAY_READ_DEADLINE_MS = 8_000

// DX-4233: the start's own retries while that read fails (the plugin's server not connected yet, a session not bound, a dashboard fault): after each
// wait in turn, on the clock, then the watchdog (a turn's end, a sub-agent's start or stop) is what is left. About five minutes.
export const RELAY_START_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000] as const

// DX-4233: the server's tool list is dynamic (it changes at sign-in, at a permission grant and at a key loss, and the engine refetches it a while
// after), so "the plugin server lists tools, none is plan_events_wait" on ONE failed wait proves nothing. A wait failing so is an old pinned
// server only once it has failed so this many times in a row, over at least this long (longer than a refetch), with the session still signed in
// and on its plan.
export const OLD_SERVER_AFTER_FAILURES = 3
export const OLD_SERVER_AFTER_MS = 8_000

// An answer that comes back sooner than this with no events is not a wait: the loop sleeps the rest, so a server that answers an
// empty list at once cannot make it spin.
export const MIN_ROUND_MS = 1_000

// DX-4233: the resume cursor, per session, in $.store (it outlives a restart); the oldest records past CURSOR_KEEP are dropped.
export const CURSOR_PREFIX = 'relayCursor:'
export const CURSOR_KEEP = 40

// One line of a failure, at most this long (a server's detail is cut).
export const FAILURE_MAX = 400

export const RELAY_OFF: RelayState = { phase: 'off', planId: null, detail: null }
