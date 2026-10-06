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

// The restart notice is for a process that STARTED or RESUMED, never after a compaction.
export const isRestartSource = (source: unknown): boolean => source === 'startup' || source === 'resume'

export const eventPath = (event: DanxEvent) => `/api/reminders/event/${event}`

// The session's own danx-dashboard server answers the restart notice itself, as a tool (no arguments).
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

// The `restart_notice` tool's answer, JSON text: `{notice: text}` (say it), `{notice: null}` (nothing to say) or
// `{stopped: {reason, detail, fix}}` (the lookup could not answer: reported, never quiet). The server does the earlier-session lookup and
// the registry wording; anything else here is a fault of the tool's answer and is reported the same way.
export function restartNoticeText(r: any): Told {
  const text = mcpText(r)
  if (r?.isError) return { kind: 'failed', reason: `error: ${text.slice(0, ERROR_BODY_MAX)}` }
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'failed', reason: `bad_response: restart_notice answered no JSON: ${text.slice(0, ERROR_BODY_MAX)}` }
  }
  if (body === null || typeof body !== 'object') return { kind: 'failed', reason: 'bad_response: restart_notice answered no object' }
  if (body.stopped !== undefined) return { kind: 'failed', reason: `${body.stopped?.reason ?? 'stopped'}: ${body.stopped?.detail ?? 'no detail'}` }
  if (body.notice === null) return { kind: 'nothing' }
  if (typeof body.notice !== 'string' || body.notice === '') return { kind: 'failed', reason: 'bad_response: restart_notice answered neither a notice, null nor a stop' }
  return { kind: 'text', text: body.notice }
}

export const eventFailureLine = (event: DanxEvent, reason: string) =>
  `⚠ Could not load the "${event}" event text from the danxbot reminder registry (${reason}). Tell the operator this event hook fetch failed.`

export const restartFailureLine = (reason: string) =>
  `⚠ Could not load the restart notice (${reason}). Tell the operator if this session should be plan-connected.`

// DX-4234: ONE deadline over the whole of a context lookup (every read of a session start or of a sub-agent start together), as the bash hook's
// `timeout 8s` was: a hung dashboard answers the failure line below instead of holding the start.
export const CONTEXT_DEADLINE_MS = 8_000
export const deadlineReason = () => `timeout: no response within ${CONTEXT_DEADLINE_MS / 1000}s`
