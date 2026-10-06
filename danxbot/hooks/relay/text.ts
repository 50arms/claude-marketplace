import { FAILURE_MAX, RELAY_MARKER } from './config'

// The one wording for a relay failure the session could not otherwise see: ONE row in its transcript, the first time a
// failure shows (a repeat of the same text is not told again), never silence. The row is read by the model, which can act on
// the fix (usually `plan_connect` again).
const trim = (text: string) => text.trim().replace(/\.+$/, '').slice(0, FAILURE_MAX)

// The relay cannot go on until something is done: the reason and the fix.
export const stoppedLine = (detail: string, fix: string) => `${RELAY_MARKER} events stopped: events are NOT reaching this session: ${trim(detail)}. Fix: ${trim(fix)}.`

// The relay is trying again on its own: a transient failure, with the cause.
export const delayedLine = (message: string) => `${RELAY_MARKER} events delayed: ${trim(message)}. The relay keeps retrying on its own.`

// DX-4233: how a delivery the session refused reads (a dropped or throwing prompt, a refused or throwing row)
export const notTakenLine = (why: string) => `the session did not take the event: ${why}`

// DX-4233: the older-release case: the session's danx-dashboard server has no plan_events_wait tool
export const OLD_SERVER_DETAIL = "this session's danx-dashboard MCP server has no plan_events_wait tool"
export const OLD_SERVER_FIX = 'restart the session so its danx-dashboard server starts at its latest release; a repo that pins its own danx-dashboard server must update it to the release that adds plan_events_wait'

// The relay's own loop hit an error nothing above anticipated: it stops for that plan until something asks for it again.
export const RELAY_ERROR_FIX = 'call plan_connect to start the relay again'
