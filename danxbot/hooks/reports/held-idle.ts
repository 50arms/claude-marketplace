// The held-idle Stop check. A plan session HOLDS a card when the card's assigned agent is the session. Holding should mean someone
// is working the card right now; a card the session holds that nobody is working is assigned to no agent (DEC-116). At turn end, for a
// plan-connected session, a card it holds that nothing is working blocks the stop once: work it now, or release it. Pure: register.tsx reads
// `GET /api/plans/<plan id>/connected-session/detail` and asks these functions what the answer means. This file is the plugin's ONE
// definition of "held idle", as ready-cards.ts is of "ready".

export type HeldCard = { id: string; title: string }

// A card of the detail's `cards` (every card this session holds), as `heldIdleOf` judges it.
type DetailCard = { id: string; title: string; activity: string | null }

export const MAX_LISTED_CARDS = 5
export const MAX_TITLE_CHARS = 80

export function detailPath(planId: number): string {
  return `/api/plans/${planId}/connected-session/detail`
}

// The work marks: the signal for the session's OWN direct work on a card (landing it, deploying it), which shows no sub-agent and no tool
// activity on the card. A session about to work a card itself says so with `PUT /api/work-marks` on it; the card then counts as
// worked while the mark lives. This is the ONE signal, chosen because the session makes it deliberately and the plugin sees it on the tool
// call itself, so nothing about the card's history is guessed. A mark expires on its own after 30 minutes, as the dashboard's does, and
// `DELETE /api/work-marks` ends it at once.
export const WORK_MARK_PATH = '/api/work-marks'
export const WORK_MARK_TTL_MS = 30 * 60_000

// Card id -> epoch ms the mark was set (or renewed).
export type WorkMarks = Record<string, number>

// The marks after one `danxbot_api` call of the session: a `PUT` of a mark on a card sets it, a `DELETE` of one clears it, anything else
// (another path, a mark on a problem, design or decision, a malformed body) changes nothing.
export function marksAfter(marks: WorkMarks, method: unknown, path: unknown, body: unknown, now: number): WorkMarks {
  if (path !== WORK_MARK_PATH || typeof method !== 'string') return marks
  const verb = method.toUpperCase()
  if (verb !== 'PUT' && verb !== 'DELETE') return marks
  const resource = (body as { resource?: { type?: unknown; id?: unknown } } | null)?.resource
  if (resource?.type !== 'issue' || typeof resource.id !== 'string' || resource.id === '') return marks
  const { [resource.id]: _gone, ...rest } = marks
  return verb === 'PUT' ? { ...rest, [resource.id]: now } : rest
}

// The card ids whose mark is still alive at `now`.
export function liveMarks(marks: WorkMarks, now: number): Set<string> {
  return new Set(Object.entries(marks).filter(([, at]) => now - at < WORK_MARK_TTL_MS).map(([id]) => id))
}

// Whether a held card is idle: nothing is on it right now (`activity` is null: no sub-agent of this session and no tool call) and the
// session has not marked it as its own work.
export function isHeldIdle(card: DetailCard, marked: ReadonlySet<string>): boolean {
  return card.activity === null && !marked.has(card.id)
}

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

// The detail's body: the held cards that are idle, in the order read. A card row it cannot judge fails the whole read.
export function heldIdleOf(body: unknown, marked: ReadonlySet<string>): Read<HeldCard[]> {
  const cards = (body as { detail?: { cards?: unknown } } | null)?.detail?.cards
  if (!Array.isArray(cards)) return { ok: false, reason: 'bad_response: GET connected-session/detail answered no detail.cards list' }
  const idle: HeldCard[] = []
  for (const raw of cards) {
    const c = raw as { id?: unknown; title?: unknown; activity?: unknown } | null
    if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.title !== 'string' || !(c.activity === null || typeof c.activity === 'string')) {
      return { ok: false, reason: 'bad_response: a held card row lacks a field the check judges' }
    }
    if (isHeldIdle({ id: c.id, title: c.title, activity: c.activity }, marked)) idle.push({ id: c.id, title: c.title })
  }
  return { ok: true, value: idle }
}

function truncate(title: string): string {
  const points = Array.from(title.replace(/\s+/g, ' ').trim())
  return points.length > MAX_TITLE_CHARS ? `${points.slice(0, MAX_TITLE_CHARS).join('')}…` : points.join('')
}

// The block reason for `cards` (at least one): the first few named, the rest counted, and the one instruction.
export function heldIdleReason(cards: readonly HeldCard[]): string {
  const listed = cards.slice(0, MAX_LISTED_CARDS).map(c => `${c.id} ${truncate(c.title)}`)
  const more = cards.length > listed.length ? `, and ${cards.length - listed.length} more` : ''
  return (
    `You hold ${cards.length} card${cards.length === 1 ? '' : 's'} nobody is working: ${listed.join('; ')}${more}. ` +
    'Work each now (a sub-agent, or mark your own work with PUT /api/work-marks), or record on the card why it waits and release it with ' +
    '`DELETE /api/issues/<id>/assigned-agent` (or `rollback_pickup` without `keep_assignment`). A card nobody is working is assigned to no agent.'
  )
}

export function heldSkippedLine(reason: string): string {
  return `danxbot held-cards check skipped (the stop is allowed): ${reason}`
}
