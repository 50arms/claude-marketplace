import type { CardLinks, ConnectedPlan, InProgressRow, ListenerStatus, PlanView, StatusBreakdown } from '../../types'
import { EMPTY, ERROR_BODY_MAX, IN_PROGRESS_LIMIT, PREFIX_PATTERN, SESSION_PLAN_PROBE, STATUS_KEYS } from './config'
import { isSignedOut, outcomeRevokedBy } from './mcp'
import type { Refusal } from '../relay/refusal'

// `$` cannot be passed across an import (`claude plugin validate`), so everything here is pure:
// the dashboard call arrives as `call`, built from `$.mcp.call` in register.tsx.
// DX-4805: `refusal`: the call was refused by auto mode's classifier (its words and the fix); `body.error` carries both.
export type Api = { ok: boolean; status: number; body: any; unreachable?: boolean; refusal?: Refusal }
export type Call = (method: string, path: string, extra?: { query?: object; body?: object }) => Promise<Api>

// DX-4458: the host's notice for a result over its size limit (written for the model, never shown to a person).
const OVERSIZE = /exceeds maximum allowed tokens/
export function isOversize(r: Api): boolean {
  return OVERSIZE.test(String(r.body?.error ?? r.body?.message ?? ''))
}

// DX-4458: one short line for a person about a call that did not work: never the host's or the server's own text.
export function failureReason(r: Api): string {
  if (isOversize(r)) return 'the dashboard answer was too large'
  return r.status > 0 ? `the dashboard answered ${r.status}` : 'the dashboard did not answer'
}

export function errText(r: Api): string {
  if (isOversize(r)) return failureReason(r)
  const b = r.body ?? {}
  return `${r.status || 'mcp'}: ${b.message ?? b.error ?? JSON.stringify(b).slice(0, ERROR_BODY_MAX)}`
}

// control flow only: thrown by `guarded` below, caught by loadPlan, never seen outside it
class SignedOut extends Error {}
class KeyRevoked extends Error {
  constructor(readonly by: string) {
    super(by)
  }
}

// The whole load. A signed-out answer to ANY of its calls (the key can be dropped between two of them) ends it as the
// `signed-out` view, and a key a person revoked as the `key-revoked` view (DX-4418), never as a generic error carrying the
// server's text. `resumePlan` is the caller's to fill.
export async function loadPlan(call: Call, refreshedAt: string): Promise<PlanView> {
  const guarded: Call = async (method, path, extra) => {
    const r = await call(method, path, extra)
    // revoked first: a revoked key's halt is a different text from the signed-out one, but the order says which wins
    const by = outcomeRevokedBy(r)
    if (by !== null) throw new KeyRevoked(by)
    if (isSignedOut(r)) throw new SignedOut()
    return r
  }
  try {
    return await readPlan(guarded, refreshedAt)
  } catch (err) {
    if (err instanceof KeyRevoked) return { ...EMPTY, phase: 'key-revoked', revokedBy: err.by, refreshedAt }
    if (err instanceof SignedOut) return { ...EMPTY, phase: 'signed-out', refreshedAt }
    throw err
  }
}

async function readPlan(call: Call, refreshedAt: string): Promise<PlanView> {
  // DX-5232: only the answer's `dashboard_url`, `session` and `sessionListenerAttached` are read; one row is asked for (DX-4458: never the whole list)
  const list = await call('GET', '/api/plans', { query: SESSION_PLAN_PROBE })
  if (!list.ok) return { ...EMPTY, phase: 'error', error: errText(list), serverNotConnected: list.unreachable === true }

  // DX-4317: the origin every link is built on. Without it no link can be right, so the load is an error.
  const dashboardUrl = readOrigin(list.body.dashboard_url)
  if (dashboardUrl === null) {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered no valid dashboard_url (an http(s) origin): cannot build plan links' }
  }
  // The session in this same response says WHICH plan; the plan itself is read by id below.
  const session = list.body.session
  const connectedId: number | null = session?.plan_id ?? null
  // DX-4374: an absent or null status is the "no status" line; a present one that is not {state: string,
  // nextStep: string | null} cannot be read, so the load fails (never nulled to the no-status line).
  const listener = readListener(list.body.sessionListenerAttached)
  if (listener === MALFORMED_LISTENER) {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered a sessionListenerAttached that is not {state: string, nextStep: string | null}: cannot show the event status' }
  }
  const noPlan = { dashboardUrl, connected: null, listener }
  if (connectedId === null) return { ...EMPTY, ...noPlan, phase: 'ready', error: null, refreshedAt }

  // One load of everything about the connected plan: the plan itself (its status counts),
  // the in-progress cards, the boards and every card, together.
  const [planR, inProg, boards, allCards] = await Promise.all([
    call('GET', `/api/plans/${connectedId}`),
    call('GET', `/api/plans/${connectedId}/cards`, { query: { bucket: 'in-progress', sort: 'priority', order: 'desc', limit: IN_PROGRESS_LIMIT } }),
    // DX-4448: the board prefixes, for the card links in assistant replies (GET /api/boards, boards.view: every
    // non-archived board of the caller's team, each with `issue_prefix`). Read here, never at draw time.
    call('GET', '/api/boards'),
    // DX-4448: every card id of the plan, whatever its board or status: the plan route is not board-scoped by the MCP (route-board-scope
    // lists `/api/plans/:planId/cards` as false; GET /api/issues would be stamped with the session's board and miss a plan's other
    // boards) and, with no `limit`, answers every row (rows come whole: the route takes no `fields`).
    call('GET', `/api/plans/${connectedId}/cards`),
  ])
  const fail = (error: string): PlanView => ({ ...EMPTY, ...noPlan, phase: 'error', error })
  if (!planR.ok) return fail(errText(planR))
  const breakdown = readBreakdown(planR.body?.status_breakdown)
  if (breakdown === null) {
    return fail(`GET /api/plans/${connectedId} answered no valid status_breakdown (all six statuses as numbers): cannot show progress`)
  }
  const connected: ConnectedPlan = {
    id: connectedId,
    ref: `PLAN-${connectedId}`,
    name: session.plan_name ?? '',
    dashboardUrl,
  }
  const base = { dashboardUrl, connected, listener, statusBreakdown: breakdown, links: readLinks(boards, allCards, connectedId, planR.body.card_count) }

  // DX-5232: the open problems are the sum of each card's `openProblemCount` on the every-card read, which must be complete to be a count.
  const counted = countOpenProblems(allCards, connectedId)
  if (typeof counted === 'string') return { ...EMPTY, ...base, phase: 'error', error: counted }
  // The in-progress bucket: the same completeness rule.
  if (!inProg.ok) return { ...EMPTY, ...base, phase: 'error', error: errText(inProg) }
  if (typeof inProg.body.total !== 'number') {
    return { ...EMPTY, ...base, phase: 'error', error: `GET /api/plans/${connectedId}/cards (in-progress) answered no total: cannot tell whether the list is complete` }
  }
  const ipRows: any[] = inProg.body.cards ?? []
  const inProgress: InProgressRow[] = ipRows.map(row => ({ id: row.id, title: row.title }))
  return {
    ...EMPTY,
    ...base,
    phase: 'ready',
    error: null,
    openProblems: counted,
    inProgress,
    refreshedAt,
  }
}

// DX-5232: the open problems on the plan's cards: the sum of `openProblemCount` over the every-card read, or the one reason it cannot
// be a count (a failed, partial or malformed read is an error, never a lower bound).
function countOpenProblems(allCards: Api, planId: number): number | string {
  const route = `GET /api/plans/${planId}/cards (all)`
  if (!allCards.ok) return `${route} ${errText(allCards)}`
  const cards = allCards.body?.cards
  if (!Array.isArray(cards)) return `${route} answered no list of cards: cannot count the open problems`
  if (typeof allCards.body.total !== 'number') return `${route} answered no total: cannot tell whether the card list is complete`
  if (allCards.body.total !== cards.length) return `${route} answered ${cards.length} of ${allCards.body.total} cards: cannot count the open problems`
  let sum = 0
  for (const c of cards) {
    if (typeof c?.openProblemCount !== 'number') return `${route} answered a card with no openProblemCount: cannot count the open problems`
    sum += c.openProblemCount
  }
  return sum
}

// DX-4448: the link data, or the one reason it could not be read. A failure here is the links' own state: the plan view stays
// `ready` (the plan itself was read), the view says why replies are not linked, and replies are drawn as written.
function readLinks(boards: Api, allCards: Api, planId: number, planCardCount: unknown): CardLinks {
  const error = (message: string): CardLinks => ({ state: 'error', message })
  if (!boards.ok) return error(`GET /api/boards ${errText(boards)}`)
  const list = boards.body?.boards
  if (!Array.isArray(list) || list.length === 0) return error('GET /api/boards answered no list of boards')
  const prefixes: unknown[] = list.map(b => b?.issue_prefix)
  if (!prefixes.every((p): p is string => typeof p === 'string' && PREFIX_PATTERN.test(p))) {
    return error('GET /api/boards answered a board with no issue_prefix of capital letters')
  }
  const route = `GET /api/plans/${planId}/cards (all)`
  if (!allCards.ok) return error(`${route} ${errText(allCards)}`)
  const cards = allCards.body?.cards
  if (!Array.isArray(cards)) return error(`${route} answered no list of cards`)
  if (typeof allCards.body.total !== 'number') return error(`${route} answered no total`)
  if (allCards.body.total !== cards.length) {
    return error(`${route} answered ${cards.length} of ${allCards.body.total} cards: cannot tell which ids are the plan's`)
  }
  // the plan's own count (every board's cards) must agree, so a board-scoped or partial answer is an error, never a smaller set
  if (planCardCount !== cards.length) return error(`${route} answered ${cards.length} cards but the plan has ${String(planCardCount)}`)
  if (!cards.every(c => typeof c?.id === 'string')) return error(`${route} answered a card with no id`)
  return { state: 'ready', prefixes: [...new Set(prefixes as string[])], planCardIds: cards.map(c => c.id) }
}

// The origin of an http(s) URL string, or null: a trailing slash or path is dropped, a non-URL is refused.
function readOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

// All six statuses as numbers, or null: a missing count is an error state, never a guessed 0%.
function readBreakdown(raw: any): StatusBreakdown | null {
  if (raw === null || typeof raw !== 'object') return null
  for (const key of STATUS_KEYS) if (typeof raw[key] !== 'number') return null
  return { 'In Progress': raw['In Progress'], ToDo: raw.ToDo, Backlog: raw.Backlog, Review: raw.Review, Done: raw.Done, Cancelled: raw.Cancelled }
}

// DX-4374: the event listener's state and next step; null when the answer carries none (the server answers null for
// a session on no plan); MALFORMED_LISTENER when one is present but not the server's shape.
const MALFORMED_LISTENER = Symbol('malformed sessionListenerAttached')
function readListener(raw: any): ListenerStatus | null | typeof MALFORMED_LISTENER {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || typeof raw.state !== 'string') return MALFORMED_LISTENER
  if (raw.nextStep !== null && typeof raw.nextStep !== 'string') return MALFORMED_LISTENER
  return { state: raw.state, nextStep: raw.nextStep }
}
