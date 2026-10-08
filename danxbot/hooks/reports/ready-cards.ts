// DX-4534 / DX-4235: the ready-cards Stop check. An orchestrating plan session must keep every unblocked card moving; nothing enforced it
// (on 2026-10-04 one builder ran while two readied, unblocked cards sat untouched). So a plan-connected session's stop is blocked once
// while its plan has ready cards nobody holds. Pure: register.tsx reads `GET /api/plans/mine`, then `GET /api/issues` on each board the
// plan spans, and asks these functions what the answers mean. This file is the plugin's ONE definition of "ready".

export type ReadyCard = { id: string; title: string }

// A card row as `isReadyCard` judges it, after `parseCardRow` proved every field present and well typed.
export type CardRow = {
  id: string
  type: string
  title: string
  assigned_agent: string | null
  dispatch: unknown
  blocked: unknown
  open_problem_count: number
  waiting_on: boolean
  conflict_on_active_count: number
}

// The dispatchable card types: Epic and Feature are containers, a Task is a leaf nobody dispatches.
const DISPATCHABLE_TYPES = new Set(['Story', 'Bug', 'Chore'])

// The fields judged beyond the always-returned row, each with the check its value must pass: the one list the request's `fields`
// tree and the row parse both come from.
const JUDGED_FIELDS: Record<string, (value: unknown) => boolean> = {
  dispatch: v => v !== undefined,
  blocked: v => v !== undefined,
  open_problem_count: v => typeof v === 'number',
  waiting_on: v => typeof v === 'boolean',
  conflict_on_active_count: v => typeof v === 'number',
}

// `GET /api/issues` page size (its maximum): a plan's ToDo cards never approach it, and a truncated page fails loudly below.
const CARDS_PAGE_SIZE = 1000

// Cards named in the block reason; the rest are counted. A listed title is cut to this many characters.
export const MAX_LISTED_CARDS = 5
export const MAX_TITLE_CHARS = 80

// The whole check (the plan read and the board reads) answers within this, or the stop is allowed with one line: a stop never waits
// on a hung dashboard.
export const READY_CARDS_DEADLINE_MS = 8_000

// The query of one board's read: the plan's ToDo cards (derived status), with the judged fields, priority first.
export function issuesQuery(planId: number): Record<string, unknown> {
  return {
    filter: { plan_id: planId, status_derived: 'ToDo' },
    fields: Object.fromEntries(Object.keys(JUDGED_FIELDS).map(name => [name, true])),
    limit: CARDS_PAGE_SIZE,
    sort: 'priority',
  }
}

// The row, or null when any judged field is missing or the wrong type: a card never counts on a guess.
export function parseCardRow(raw: unknown): CardRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.type !== 'string' || typeof r.title !== 'string') return null
  if (!(r.assigned_agent === null || typeof r.assigned_agent === 'string')) return null
  if (!Object.entries(JUDGED_FIELDS).every(([name, valid]) => valid(r[name]))) return null
  return r as unknown as CardRow
}

// Whether a ToDo card could be claimed right now: a dispatchable type, nobody holding it (no assigned agent, no live dispatch), and
// nothing in its way (no hold, no open problem, no unmet depends_on, no active conflict_on). A card whose reason it cannot run is recorded
// on it stops counting, which is what makes the block's "dispatch it, or record why not" satisfiable.
export function isReadyCard(card: CardRow): boolean {
  return (
    DISPATCHABLE_TYPES.has(card.type) &&
    card.assigned_agent === null &&
    card.dispatch === null &&
    card.blocked === null &&
    card.open_problem_count === 0 &&
    !card.waiting_on &&
    card.conflict_on_active_count === 0
  )
}

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

// `GET /api/plans/mine`'s body: the plan id and the boards its cards live on.
export function planOf(body: unknown): Read<{ planId: number; boards: string[] }> {
  const b = body as { id?: unknown; boards?: unknown } | null
  if (b === null || typeof b !== 'object' || typeof b.id !== 'number' || !Array.isArray(b.boards) || !b.boards.every(x => typeof x === 'string')) {
    return { ok: false, reason: 'bad_response: GET /api/plans/mine answered no plan id and boards' }
  }
  return { ok: true, value: { planId: b.id, boards: b.boards as string[] } }
}

// One board's `GET /api/issues` body: its ready cards, in the order read. A truncated page or a row it cannot judge fails the whole read.
export function readyCardsOf(body: unknown): Read<ReadyCard[]> {
  const b = body as { issues?: unknown; total?: unknown } | null
  if (b === null || typeof b !== 'object' || !Array.isArray(b.issues) || typeof b.total !== 'number') {
    return { ok: false, reason: 'bad_response: GET /api/issues answered no issues list and total' }
  }
  if (b.total > b.issues.length) return { ok: false, reason: `too_many_cards: the plan has ${b.total} ToDo cards on one board, more than one read returns` }
  const cards: ReadyCard[] = []
  for (const raw of b.issues) {
    const card = parseCardRow(raw)
    if (card === null) return { ok: false, reason: 'bad_response: a card row lacks a field the check judges' }
    if (isReadyCard(card)) cards.push({ id: card.id, title: card.title })
  }
  return { ok: true, value: cards }
}

function truncate(title: string): string {
  const points = Array.from(title.replace(/\s+/g, ' ').trim())
  return points.length > MAX_TITLE_CHARS ? `${points.slice(0, MAX_TITLE_CHARS).join('')}…` : points.join('')
}

// The block reason for `cards` (at least one): the first few named, the rest counted, and the one instruction.
export function blockReason(cards: readonly ReadyCard[]): string {
  const listed = cards.slice(0, MAX_LISTED_CARDS).map(c => `${c.id} ${truncate(c.title)}`)
  const more = cards.length > listed.length ? `, and ${cards.length - listed.length} more` : ''
  return (
    `Your plan has ${cards.length} ready, unblocked card${cards.length === 1 ? '' : 's'} nobody is working: ${listed.join('; ')}${more}. ` +
    'Dispatch each now, or record on the card why it cannot run (dependency, problem, block).'
  )
}

// The one line a failed read shows: the stop is allowed, and why the check could not run.
export function skippedLine(reason: string): string {
  return `danxbot ready-cards check skipped (the stop is allowed): ${reason}`
}
