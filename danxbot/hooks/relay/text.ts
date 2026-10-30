import { FAILURE_MAX, RELAY_MARKER } from './config'

// The one wording for a relay failure the session could not otherwise see: ONE row in its transcript, the first time a
// failure shows (a repeat of the same text is not told again), never silence. The row is read by the model, which can act on
// the fix (usually `plan_connect` again).
const trim = (text: string) => text.trim().replace(/\.+$/, '').slice(0, FAILURE_MAX)

// The relay cannot go on until something is done: the reason and the fix.
const eventsLine = (state: 'stopped' | 'delayed', detail: string, fix: string) => `${RELAY_MARKER} events ${state}: events are NOT reaching this session: ${trim(detail)}. Fix: ${trim(fix)}.`
export const stoppedLine = (detail: string, fix: string) => eventsLine('stopped', detail, fix)

// the auto mode classifier refused the relay's call: told to the session once; the relay retries on its own and resumes when the calls are allowed.
export const refusedLine = (detail: string, fix: string) => eventsLine('delayed', detail, fix)

// The relay is trying again on its own: a transient failure, with the cause.
export const delayedLine = (message: string) => `${RELAY_MARKER} events delayed: ${trim(message)}. The relay keeps retrying on its own.`

// the relay's loop made no step for a long time (a call it waits on never settled): events were NOT reaching this session meanwhile. It is
// started again on its own; the line is for the person (a toast) and the session (a note), never silence.
export const stalledNotice = (seconds: number) =>
  `Plan events stalled: the listener made no progress for ${seconds} s, so events were NOT reaching this session. It was started again on its own; if events stay silent, call plan_connect.`
export const stalledLine = (seconds: number) => `${RELAY_MARKER} ${stalledNotice(seconds)}`

// how a delivery the session refused reads (a dropped or throwing prompt, a refused or throwing row)
export const notTakenLine = (why: string) => `the session did not take the event: ${why}`

// Claude Code's drop while a Stop stands ("the session was stopped and nobody has sent input since"): only the person's own message lifts it,
// so it is the person's step, never a fault the relay or the model can fix. Matched on the engine's words, the only signal it gives.
export const heldForInput = (failure: string) => /nobody has sent input since/i.test(failure)
export const HELD_FOR_INPUT_NOTICE = 'Plan events are waiting: this session was stopped, and Claude Code holds them until you send it a message. Send any message here to resume it.'
export const HELD_FOR_INPUT_BAND = 'Events waiting: send any message to resume this session.'

// the older-release case: the session's danx-dashboard server has no plan_events_wait tool
export const OLD_SERVER_DETAIL = "this session's danx-dashboard MCP server has no plan_events_wait tool"
export const OLD_SERVER_FIX = 'restart the session so its danx-dashboard server starts at its latest release; a repo that pins its own danx-dashboard server must update it to the release that adds plan_events_wait'

// the same older-release case, seen from the answer: its records carry no `urgent` flag, which a server older than the release that adds it
// never sends
export const NO_URGENT_DETAIL = "this session's danx-dashboard MCP server answers events with no urgent flag, so it is older than this plugin needs"
export const NO_URGENT_FIX = 'restart the session so its danx-dashboard server starts at its latest release'

// the same older-release case for the `acks` list, seen from the answer, and from a queued event a previous plugin version kept without one
export const NO_ACKS_DETAIL = "this session's danx-dashboard MCP server answers events with no acks list, so it is older than this plugin needs"
export const NO_ACKS_FIX = NO_URGENT_FIX
export const STALE_PENDING_DETAIL = 'events queued by an older version of this plugin are still waiting and carry no acks list, so they cannot be delivered'
export const STALE_PENDING_FIX = 'restart the session so the plugin starts with an empty queue; the server then resumes from the stored cursor, so every event past it is sent again'

// The relay's own loop hit an error nothing above anticipated: it stops for that plan until something asks for it again.
export const RELAY_ERROR_FIX = 'call plan_connect to start the relay again'
