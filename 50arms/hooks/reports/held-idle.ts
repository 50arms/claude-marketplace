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

// The sub-agents' briefs. A running sub-agent of the session that was briefed on a card is working it, even before it has
// claimed it or between its tool calls, when the dashboard shows no activity on the card. The plugin sees a spawn's prompt (`agent.spawn`) but
// not which agent id it gets, so each admitted spawn's card ids wait in `pending` (oldest first) and the next sub-agent start takes the oldest.
export const BRIEF_PENDING_TTL_MS = 5 * 60_000
export type Briefs = { pending: { ids: string[]; at: number }[]; byAgent: Record<string, string[]> }
export const NO_BRIEFS: Briefs = { pending: [], byAgent: {} }

const CARD_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g

// The card ids a brief names, each once.
export function cardIdsIn(text: unknown): string[] {
  return typeof text === 'string' ? [...new Set(text.match(CARD_ID) ?? [])] : []
}

function fresh(b: Briefs, now: number): Briefs['pending'] {
  return b.pending.filter(p => now - p.at < BRIEF_PENDING_TTL_MS)
}

// A spawn the engine admitted, briefed with `prompt`.
export function briefSpawned(b: Briefs, prompt: unknown, now: number): Briefs {
  return { ...b, pending: [...fresh(b, now), { ids: cardIdsIn(prompt), at: now }] }
}

// A sub-agent started: it takes the oldest unclaimed brief (none: a resumed agent keeps the brief it had, any other was briefed on no card the plugin saw).
export function briefClaimed(b: Briefs, agentId: string, now: number): Briefs {
  const [first, ...rest] = fresh(b, now)
  return { pending: rest, byAgent: { ...b.byAgent, [agentId]: first?.ids ?? b.byAgent[agentId] ?? [] } }
}

// A sub-agent ended.
export function briefEnded(b: Briefs, agentId: string): Briefs {
  const { [agentId]: _gone, ...rest } = b.byAgent
  return { ...b, byAgent: rest }
}

// The cards a sub-agent that ended a moment ago was briefed on stay worked for a few minutes: the session reads the agent's report and acts on it
// between that agent's end and its next spawn, and the dashboard shows no activity on the card in that gap.
export const RECENT_BRIEF_MS = 5 * 60_000
export type RecentBriefs = { ids: string[]; at: number }[]
export const NO_RECENT: RecentBriefs = []

// The ended sub-agent `agentId`'s brief joins the recent ones (older ones fall away).
export function briefRecent(recent: RecentBriefs, b: Briefs, agentId: string, now: number): RecentBriefs {
  return [...recent.filter(r => now - r.at < RECENT_BRIEF_MS), { ids: b.byAgent[agentId] ?? [], at: now }]
}

// The card ids a still-running sub-agent was briefed on, and those of a sub-agent that ended in the last few minutes.
export function briefedCards(b: Briefs, running: readonly string[], recent: RecentBriefs, now: number): Set<string> {
  return new Set([...running.flatMap(id => b.byAgent[id] ?? []), ...recent.filter(r => now - r.at < RECENT_BRIEF_MS).flatMap(r => r.ids)])
}

// Whether a held card is idle: nothing is on it right now (`activity` is null: no sub-agent of this session and no tool call) and no sub-agent
// of the session was briefed on it while running or in the last few minutes (`worked`).
export function isHeldIdle(card: DetailCard, worked: ReadonlySet<string>): boolean {
  return card.activity === null && !worked.has(card.id)
}

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

// The detail's body: the held cards that are idle, in the order read. A card row it cannot judge fails the whole read.
export function heldIdleOf(body: unknown, worked: ReadonlySet<string>): Read<HeldCard[]> {
  const cards = (body as { detail?: { cards?: unknown } } | null)?.detail?.cards
  if (!Array.isArray(cards)) return { ok: false, reason: 'bad_response: GET connected-session/detail answered no detail.cards list' }
  const idle: HeldCard[] = []
  for (const raw of cards) {
    const c = raw as { id?: unknown; title?: unknown; activity?: unknown } | null
    if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.title !== 'string' || !(c.activity === null || typeof c.activity === 'string')) {
      return { ok: false, reason: 'bad_response: a held card row lacks a field the check judges' }
    }
    if (isHeldIdle({ id: c.id, title: c.title, activity: c.activity }, worked)) idle.push({ id: c.id, title: c.title })
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
    'Work each now (a sub-agent), or record on the card why it waits and release it with ' +
    '`DELETE /api/issues/<id>/assigned-agent` (or `rollback_pickup` without `keep_assignment`). A card nobody is working is assigned to no agent.'
  )
}

export function heldSkippedLine(reason: string): string {
  return `50 Arms held-cards check skipped (the stop is allowed): ${reason}`
}
