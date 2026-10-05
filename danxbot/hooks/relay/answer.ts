import { SIGNED_OUT_MARK } from '../plan/config'
import { RELAY_TOOL, FAILURE_MAX, WAIT_MS } from './config'
import { isServerNotConnected, keyRevokedBy, mcpText } from '../plan/mcp'

// What one `plan_events_wait` call came to. The tool answers (danxbot packages/danx-dashboard-mcp, plan_events_wait):
//   {events: [{cursor: string, text: string}]}   (events empty when the wait timed out)
//   {stopped: {reason, detail, fix}}             (the relay cannot go on: the server's own detail and fix; the reason is for the server's logs)
// as JSON text. Anything else is a failure shown as one, never an empty list (Core Principle 1).
// A record's `cursor` is an opaque string the server minted: what to send back, and store, once that record is delivered. The plugin
// never reads it, compares it or orders by it (ids can become visible out of order, so no rule over them is safe): it delivers the
// records in the order the server sent them and keeps the cursor of the last one delivered.
export type RelayEvent = { cursor: string; text: string }
export type WaitAnswer =
  | { kind: 'events'; events: RelayEvent[] }
  | { kind: 'stopped'; detail: string; fix: string }
  // the session holds no dashboard key, or a person revoked it (the server's sign-in or revoked-key halt): the band and pane already say
  // so (view phases); nothing more is told
  | { kind: 'signed-out' }
  // the session's danx-dashboard server has no such tool (an older release, or a repo's own pinned copy)
  | { kind: 'old-server' }
  | { kind: 'failed'; message: string }

// The arguments of one `plan_events_wait` call, built here and nowhere else: the plan the relay serves (the server starts clean
// whenever it changes), the cursor, how long the server may hold the call, and the transcript path when one is known.
export function waitArgs(planId: number, cursor: string | null, transcriptPath: string | null) {
  return { plan_id: planId, cursor, timeout_ms: WAIT_MS, ...(transcriptPath !== null ? { transcript_path: transcriptPath } : {}) }
}

// how much of a malformed answer's text one failure line quotes
const SNIPPET_MAX = 120
const cut = (text: string, max = FAILURE_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text)

const isEvent = (x: any): x is RelayEvent =>
  x !== null && typeof x === 'object' && typeof x.text === 'string' && x.text !== '' && typeof x.cursor === 'string' && x.cursor !== ''

// DX-4233: a malformed answer is a loud failure, never an empty list (Core Principle 1)
export function readWaitAnswer(r: any): WaitAnswer {
  if (r === null || r === undefined) return { kind: 'failed', message: `${RELAY_TOOL} answered no result` }
  const text = mcpText(r)
  if (r.isError) return classifyText(text)
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'failed', message: `${RELAY_TOOL} answered text that is not JSON: ${cut(text, SNIPPET_MAX)}` }
  }
  if (parsed !== null && typeof parsed === 'object' && parsed.stopped !== undefined) {
    const s = parsed.stopped
    if (s === null || typeof s !== 'object' || typeof s.detail !== 'string' || typeof s.fix !== 'string') {
      return { kind: 'failed', message: `${RELAY_TOOL} answered a stopped record that is not {detail, fix}: ${cut(text, SNIPPET_MAX)}` }
    }
    return { kind: 'stopped', detail: s.detail, fix: s.fix }
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.events) && parsed.events.every(isEvent)) {
    return { kind: 'events', events: parsed.events }
  }
  return { kind: 'failed', message: `${RELAY_TOOL} answered neither {events} nor {stopped}: ${cut(text, SNIPPET_MAX)}` }
}

// An error result's text: the server's sign-in halt, its revoked-key halt, an unknown tool, or any other failure.
function classifyText(text: string): WaitAnswer {
  if (keyRevokedBy(text) !== null || text.includes(SIGNED_OUT_MARK)) return { kind: 'signed-out' }
  if (/unknown tool|no such tool|not found/i.test(text) && text.includes(RELAY_TOOL)) return { kind: 'old-server' }
  return { kind: 'failed', message: cut(text) }
}

// What `$.mcp.call` rejects with. The engine's "no connected MCP tool" means this session's server has no such tool (the server
// was found by name, or none is connected at all: either way there is nothing to wait on).
export function classifyCallError(message: string): WaitAnswer {
  // DX-4233: a session whose plugin server has no such tool (not connected yet, or an older release) has nothing to wait on
  if (isServerNotConnected(message)) return { kind: 'old-server' }
  return classifyText(message)
}
