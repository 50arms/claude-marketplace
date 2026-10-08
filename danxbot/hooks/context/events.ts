import type { Api } from '../plan/load'
import { errText } from '../plan/load'
import { ERROR_BODY_MAX } from '../plan/config'
import { mcpText } from '../plan/mcp'

// DX-4234: the event text a plan-connected session is told, and the restart notice a session that replaced a connected one is told.
// The wording is a danxbot registry row (`GET /api/reminders/event/:event`, the `plan_restart.waiting_events` reminder); this file
// carries no wording of its own but the two failure lines.

// danxbot's four events. A SessionStart `source` of `clear` or `fork` has none: it is told nothing.
export type DanxEvent = 'session_start' | 'session_resume' | 'after_compaction' | 'sub_agent_start'

export function sessionEvent(source: unknown): DanxEvent | null {
  switch (source) {
    case 'startup':
      return 'session_start'
    case 'resume':
      return 'session_resume'
    case 'compact':
      return 'after_compaction'
    default:
      return null
  }
}

// What `restart_notice` is asked with, by how the session started (the server's contract: a transcript path finds the nearest ancestor in the
// transcript's copied prefix, a named predecessor asks only that record, neither scans the project). A resume (a desktop fork reports it too)
// names its transcript and a startup names neither; a start that lacks what its source needs is a failure, never a silent fall back to the project
// scan. A clear names the session that just ended and is asked from `clearNotice`; a compaction is the same session and asks nothing.
export type RestartAsk = { kind: 'ask'; args: Record<string, string> } | { kind: 'failed'; reason: string }
export function restartAsk(start: { source: string; transcriptPath: string | null }): RestartAsk {
  if (start.source !== 'resume') return { kind: 'ask', args: {} }
  return start.transcriptPath === null ? { kind: 'failed', reason: 'no_transcript_path: SessionStart resume carried no transcript_path' } : { kind: 'ask', args: { transcript_path: start.transcriptPath } }
}

// The registry's event texts: the four told at a start and the keepalive's, which a timer asks for (not a `DanxEvent`: eventContext takes only those)
export type RegistryEvent = DanxEvent | 'tab_keepalive'
export const eventPath = (event: RegistryEvent) => `/api/reminders/event/${event}`

// The session's own danx-dashboard server answers the restart notice itself, as a tool.
export const RESTART_NOTICE_TOOL = 'restart_notice'

// What a lookup came to: text to say, nothing to say, or a failure whose reason names why (one line, never silence).
export type Told = { kind: 'text'; text: string } | { kind: 'nothing' } | { kind: 'failed'; reason: string }

export function eventText(r: Api): Told {
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  const text = r.body?.effective_text
  if (typeof text !== 'string') return { kind: 'failed', reason: 'bad_response: the dashboard answered no effective_text' }
  if (text === '') return { kind: 'failed', reason: 'empty_response: the dashboard returned an empty text' }
  return { kind: 'text', text }
}

// The three answers of the server's `restart_notice` tool (JSON text): say the notice, say nothing, or the lookup could not answer. `fix`
// is the server's own remedy text (it tells the session to continue and to call plan_connect).
export type RestartNoticeAnswer = { notice: string } | { notice: null } | { stopped: { reason: string; detail: string; fix: string } }

const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

// The answer as the contract words it, or null for any other shape.
function asRestartNoticeAnswer(value: unknown): RestartNoticeAnswer | null {
  if (value === null || typeof value !== 'object') return null
  if ('stopped' in value) {
    const s = value.stopped
    if (s === null || typeof s !== 'object') return null
    const { reason, detail, fix } = s as Record<string, unknown>
    return isText(reason) && isText(detail) && isText(fix) ? { stopped: { reason, detail, fix } } : null
  }
  if (!('notice' in value)) return null
  // keys beyond the contract's are ignored on purpose: a newer server may add fields, and none changes what the model is told
  return value.notice === null || isText(value.notice) ? (value as RestartNoticeAnswer) : null
}

// What the model is told of one `restart_notice` result. A stop is a failure carrying the server's reason, detail and fix; an error result,
// text that is not JSON and an answer of no known shape are failures too, never quiet.
export function restartNoticeText(result: { content?: { type: string; text?: string }[]; isError?: boolean } | null | undefined): Told {
  const text = mcpText(result)
  if (result?.isError) return { kind: 'failed', reason: `error: ${text.slice(0, ERROR_BODY_MAX)}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'failed', reason: `bad_response: restart_notice answered no JSON: ${text.slice(0, ERROR_BODY_MAX)}` }
  }
  const answer = asRestartNoticeAnswer(parsed)
  if (answer === null) return { kind: 'failed', reason: 'bad_response: restart_notice answered neither a notice, null nor a stop' }
  if ('stopped' in answer) return { kind: 'failed', reason: `${answer.stopped.reason}: ${answer.stopped.detail}. ${answer.stopped.fix}` }
  return answer.notice === null ? { kind: 'nothing' } : { kind: 'text', text: answer.notice }
}

export const eventFailureLine = (event: DanxEvent, reason: string) =>
  `⚠ Could not load the "${event}" event text from the danxbot reminder registry (${reason}). Tell the operator this event hook fetch failed.`

export const restartFailureLine = (reason: string) =>
  `⚠ Could not load the restart notice (${reason}). Tell the operator if this session should be plan-connected.`

// DX-4234: ONE deadline over the plugin's own work in a context lookup (the wait for the server, the plan read and the event text read of a
// session start, or the reads of a sub-agent start, together), as the bash hook's `timeout 8s` was: a hung dashboard answers the failure line
// below instead of holding the start. The restart notice is the server's own lookup and has its own 8 s deadline (`lookup_timeout`).
export const CONTEXT_DEADLINE_MS = 8_000
// The plugin's own server was not in the session's tool list by the deadline (said only for a session known to be on a plan).
export const SERVER_NOT_CONNECTED_REASON = `server_not_connected: the danxbot dashboard server was not connected within ${CONTEXT_DEADLINE_MS / 1000}s`
export const DEADLINE_REASON = `timeout: no response within ${CONTEXT_DEADLINE_MS / 1000}s`
