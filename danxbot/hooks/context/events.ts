import type { Api } from '../plan/load'
import { errText } from '../plan/load'

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
export const restartNoticePath = (sessionId: string) => `/api/plan-sessions/${encodeURIComponent(sessionId)}/restart-notice`

// The registry row whose text is the restart notice (danxbot src/issues/reminders/seed.yaml).
export const RESTART_NOTICE_KEY = 'plan_restart.waiting_events'

// What a lookup came to: text to say, nothing to say, or a failure whose reason names why (one line, never silence).
export type Told = { kind: 'text'; text: string } | { kind: 'nothing' } | { kind: 'failed'; reason: string }

export function eventText(r: Api): Told {
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  const text = r.body?.effective_text
  if (typeof text !== 'string') return { kind: 'failed', reason: 'bad_response: the dashboard answered no effective_text' }
  if (text === '') return { kind: 'failed', reason: 'empty_response: the dashboard returned an empty text' }
  return { kind: 'text', text }
}

// One earlier session's restart notice: `restart: null` is nothing to say (the plan is archived, the session is still live, ...);
// a notice whose registry row is missing is a server fault, reported, never papered over.
export function restartText(r: Api): Told {
  if (!r.ok) return { kind: 'failed', reason: errText(r) }
  if (r.body === null || typeof r.body !== 'object' || !('restart' in r.body)) return { kind: 'failed', reason: 'bad_response: the dashboard answered no restart field' }
  if (r.body.restart === null) return { kind: 'nothing' }
  const rows: any[] = Array.isArray(r.body.reminders) ? r.body.reminders : []
  const text = rows.find(x => x?.key === RESTART_NOTICE_KEY)?.text
  if (typeof text !== 'string' || text === '') return { kind: 'failed', reason: 'bad_response: the dashboard answered a notice without its registry text' }
  return { kind: 'text', text }
}

export const eventFailureLine = (event: DanxEvent, reason: string) =>
  `⚠ Could not load the "${event}" event text from the danxbot reminder registry (${reason}). Tell the operator this event hook fetch failed.`

export const restartFailureLine = (reason: string) =>
  `⚠ Could not load the restart notice (${reason}). Tell the operator if this session should be plan-connected.`

// DX-4234: ONE deadline over the whole of a context lookup (every read of a session start or of a sub-agent start together), as the bash hook's
// `timeout 8s` was: a hung dashboard answers the failure line below instead of holding the start.
export const CONTEXT_DEADLINE_MS = 8_000
export const deadlineReason = () => `timeout: no response within ${CONTEXT_DEADLINE_MS / 1000}s`
