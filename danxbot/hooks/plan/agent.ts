import type { HeldCard, SessionAgent } from '../../types'

// DX-5554: the session's team agent and what it holds, as GET /api/plans answers them on its `session` (the plan_session resource: `agent`
// {id, name, avatar_url} or null, DX-5551; `card_id` / `card_title`, DX-5553), and the release of the agent when the session ends.

// What a session row's agent and card read as, or the reason the row cannot be read (the load then fails: never a guessed name or card).
export type SessionHolds = { agent: SessionAgent | null; card: HeldCard | null } | { error: string }

export function readSessionHolds(session: any): SessionHolds {
  if (session === null || session === undefined) return { agent: null, card: null }
  const agent = readAgent(session.agent)
  if (agent === MALFORMED) return { error: 'GET /api/plans answered a session whose agent is not {id, name, avatar_url} or null: cannot name the agent the session signs in as' }
  const card = readCard(session.card_id, session.card_title)
  if (card === MALFORMED) return { error: 'GET /api/plans answered a session whose card_id and card_title are not a card id and its title, or both null: cannot name the card it holds' }
  return { agent, card }
}

const MALFORMED = Symbol('malformed session row')
const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

function readAgent(raw: any): SessionAgent | null | typeof MALFORMED {
  if (raw === null) return null
  if (raw === undefined || typeof raw !== 'object' || typeof raw.id !== 'number' || !isText(raw.name)) return MALFORMED
  if (raw.avatar_url !== null && !isText(raw.avatar_url)) return MALFORMED
  return { name: raw.name, avatarUrl: raw.avatar_url }
}

function readCard(id: unknown, title: unknown): HeldCard | null | typeof MALFORMED {
  if (id === null && title === null) return null
  return isText(id) && typeof title === 'string' ? { id, title } : MALFORMED
}

// The release: frees the agent for the team at once instead of the dashboard's 30-minute dead-session window. Idempotent on the server
// (`{released: false}` for a session that held none). Bounded, so a dashboard that never answers holds the session's end this long at most.
export const AGENT_RELEASE_PATH = '/api/plan-sessions/me/agent'
export const AGENT_RELEASE_DEADLINE_MS = 3_000
export const AGENT_RELEASE_TIMEOUT_REASON = `timeout: no response within ${AGENT_RELEASE_DEADLINE_MS / 1000}s`
// The reason is cut so the toast keeps its second half (the consequence) within the toast's length.
const RELEASE_REASON_MAX = 70
export const releaseFailureToast = (reason: string) =>
  `Could not free this session's team agent (${reason.length > RELEASE_REASON_MAX ? `${reason.slice(0, RELEASE_REASON_MAX - 1)}…` : reason}); it is freed 30 minutes after the session ends.`
