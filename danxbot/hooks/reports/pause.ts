// DX-4997 / DX-4951: the agent pause, as the plugin's hooks read it. A session with nothing it can do tells 50 Arms so (`PUT` this path); while the pause
// stands, the dashboard holds the machine's messages, so a hook that would cost the session a paid turn (the ready-cards Stop reminder, the plan-tab
// keepalive) stays quiet. Pure: register.tsx makes the read and asks these functions what the answer means.

// `GET` answers `{pause}`: null, the session's agent pause, or a usage-limit pause. The read stamps nothing and ends nothing: it is the ONE
// pause-neutral read (every other call carrying the session header to a card or plan route is the agent's own call and ends its pause).
export const PAUSE_PATH = '/api/plan-sessions/me/pause'

export type PauseRead = { kind: 'free' } | { kind: 'nothing' } | { kind: 'paused'; reason: string; until: number } | { kind: 'failed'; reason: string }

// The answer of one read at wall-clock `now` (epoch ms). Only an unexpired AGENT pause quiets a hook: no pause, a usage-limit pause (its own
// mechanism, which the hooks never keyed on) and an agent pause past its expiry (the server ends it on its next tick) are all free.
export function pauseOf(body: unknown, now: number): PauseRead {
  const pause = (body as { pause?: unknown } | null)?.pause
  if (pause === null) return { kind: 'free' }
  if (pause === undefined || typeof pause !== 'object') return { kind: 'failed', reason: `bad_response: GET ${PAUSE_PATH} answered no pause field` }
  const p = pause as { limit?: unknown; until?: unknown; reason?: unknown }
  if (p.limit !== 'agent') return { kind: 'free' }
  const until = typeof p.until === 'string' ? Date.parse(p.until) : NaN
  if (Number.isNaN(until) || typeof p.reason !== 'string') return { kind: 'failed', reason: `bad_response: GET ${PAUSE_PATH} answered an agent pause with no expiry or reason` }
  return until > now ? { kind: 'paused', reason: p.reason, until } : { kind: 'free' }
}

// A dashboard older than this plugin has no pause route (404). The hooks then behave as "not paused", and the person is told once.
export const OLDER_DASHBOARD_LINE =
  'danxbot: this dashboard has no agent-pause route yet (GET /api/plan-sessions/me/pause answered 404), so reminders and keepalive prompts are not paused for you. ' +
  'It starts working once the dashboard is updated.'
