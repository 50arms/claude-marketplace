import type { CardLinks, CommentRow, ConnectedPlan, ProblemDetail, InProgressRow, ListenerStatus, PlanRow, PlanView, ProblemRow, SolutionRow, StatusBreakdown, StepRow, SubagentRow, SubagentsView } from '../../types'
import { EMPTY, ERROR_BODY_MAX, MAX_CARDS, MAX_PLANS, MAX_SESSIONS, NEEDS_YOU_BUCKET_ID, PREFIX_PATTERN, STATUS_KEYS } from './config'
import { isSignedOut, outcomeRevokedBy } from './mcp'
import { parentLoop, toSubagent } from './subagents'

// `$` cannot be passed across an import (`claude plugin validate`), so everything here is pure:
// the dashboard call arrives as `call`, built from `$.mcp.call` in register.tsx.
export type Api = { ok: boolean; status: number; body: any; unreachable?: boolean }
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

function toSteps(raw: any[]): StepRow[] {
  return (raw ?? []).map(s => ({
    id: s.id,
    label: s.label,
    title: s.title,
    description: s.description ?? '',
    checked: s.checked_at !== null && s.checked_at !== undefined,
    steps: toSteps(s.steps ?? []),
  }))
}

function toSolutions(raw: any[]): SolutionRow[] {
  return (raw ?? [])
    .filter((s: any) => !s.removed)
    .map(
      (s: any): SolutionRow => ({
        id: s.id,
        title: s.title,
        body: s.body ?? '',
        pro: s.pro ?? '',
        con: s.con ?? '',
        recommended: !!s.recommended,
        steps: toSteps(s.steps ?? []),
      }),
    )
    // recommended first, as the browser sorts them
    .sort((a: SolutionRow, b: SolutionRow) => Number(b.recommended) - Number(a.recommended))
}

// DX-4458: a card read for its problem rows only. The solutions, steps and comments of a problem are read when the
// person opens it (`withDetail`): a card with dozens of problems answers over the host's size limit when they all come at once.
export function toProblems(card: any, priority: number): ProblemRow[] {
  // DX-4232 PBLM-1913: an answered problem leaves the pane at once; its history lives in the browser.
  return (card.problems ?? [])
    .filter((p: any) => p.open)
    .map(
      (p: any): ProblemRow => ({
        id: p.id,
        cardId: card.id,
        cardTitle: card.title,
        priority,
        type: p.type === 'action' ? 'action' : 'question',
        statement: p.statement,
        summary: p.summary ?? null,
        context: p.context ?? null,
        updatedAt: p.updated_at,
        detail: null,
        detailError: null,
      }),
    )
}

// DX-4458: what an opened problem shows beyond its row: its solutions (the problems route answers them with their
// steps; `q` narrows it to the problem by its statement) and its card's comments. A failure is that problem's own line.
async function withDetail(call: Call, p: ProblemRow): Promise<ProblemRow> {
  const [sol, com] = await Promise.all([
    call('GET', `/api/issues/${p.cardId}/problems`, { query: { q: p.statement, status: 'open' } }),
    call('GET', `/api/issues/${p.cardId}`, { query: { fields: { comments: true } } }),
  ])
  const failed = (what: string, r: Api): ProblemRow => ({ ...p, detailError: `Couldn't load the ${what} of PBLM-${p.id}: ${failureReason(r)}` })
  if (!sol.ok) return failed('solutions', sol)
  if (!com.ok) return failed('comments', com)
  const found = (sol.body.problems ?? []).find((x: any) => x.id === p.id)
  if (!found) return { ...p, detailError: `PBLM-${p.id} is no longer open on ${p.cardId}: refresh the pane.` }
  // a card's comments are paged: without comments_page.total they cannot be read as complete
  if (typeof com.body.comments_page?.total !== 'number') return { ...p, detailError: `Couldn't load the comments of PBLM-${p.id}: the dashboard did not say how many there are` }
  const comments: any[] = com.body.comments ?? []
  const detail: ProblemDetail = {
    solutions: toSolutions(found.solutions),
    comments: comments
      .filter(c => c.problem_id === p.id)
      .map((c): CommentRow => ({ id: String(c.id), author: c.author ?? '', at: c.timestamp, text: c.text ?? '' })),
    // comments on the card the API did not return
    moreComments: Math.max(0, com.body.comments_page.total - comments.length),
  }
  return { ...p, detail }
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
export async function loadPlan(call: Call, refreshedAt: string, expandedId: number | null): Promise<PlanView> {
  const guarded: Call = async (method, path, extra) => {
    const r = await call(method, path, extra)
    // revoked first: a revoked key's halt is a different text from the signed-out one, but the order says which wins
    const by = outcomeRevokedBy(r)
    if (by !== null) throw new KeyRevoked(by)
    if (isSignedOut(r)) throw new SignedOut()
    return r
  }
  try {
    return await readPlan(guarded, refreshedAt, expandedId)
  } catch (err) {
    if (err instanceof KeyRevoked) return { ...EMPTY, phase: 'key-revoked', revokedBy: err.by, refreshedAt }
    if (err instanceof SignedOut) return { ...EMPTY, phase: 'signed-out', refreshedAt }
    throw err
  }
}

async function readPlan(call: Call, refreshedAt: string, expandedId: number | null): Promise<PlanView> {
  const list = await call('GET', '/api/plans', { query: { limit: MAX_PLANS } })
  if (!list.ok) return { ...EMPTY, phase: 'error', error: errText(list), serverNotConnected: list.unreachable === true }

  // A paged route that does not say how many there are cannot be read as complete.
  if (typeof list.body.total !== 'number') {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered no total: cannot tell whether the plan list is complete' }
  }
  // DX-4317: the origin every link is built on. Without it no link can be right, so the load is an error.
  const dashboardUrl = readOrigin(list.body.dashboard_url)
  if (dashboardUrl === null) {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered no valid dashboard_url (an http(s) origin): cannot build plan links' }
  }
  const plansRead: any[] = list.body.plans ?? []
  const plansUnread = Math.max(0, list.body.total - plansRead.length)
  const plans: PlanRow[] = plansRead
    .filter((p: any) => !p.archived_at)
    .map((p: any) => ({
      id: p.id,
      ref: p.ref,
      name: p.name,
      status: p.status,
      needsYou: p.bucket_counts?.[NEEDS_YOU_BUCKET_ID] ?? 0,
    }))
  // The session in this same response says WHICH plan; the plan itself is read by id below.
  const session = list.body.session
  const connectedId: number | null = session?.plan_id ?? null
  // DX-4374: an absent or null status is the "no status" line; a present one that is not {state: string,
  // nextStep: string | null} cannot be read, so the load fails (never nulled to the no-status line).
  const listener = readListener(list.body.sessionListenerAttached)
  if (listener === MALFORMED_LISTENER) {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered a sessionListenerAttached that is not {state: string, nextStep: string | null}: cannot show the event bridge' }
  }
  const noPlan = { dashboardUrl, connected: null, plans, listener, cardsTotal: 0, cardsRead: 0, plansUnread }
  if (connectedId === null) return { ...EMPTY, ...noPlan, phase: 'ready', error: null, refreshedAt }

  // One load of everything about the connected plan: the plan itself (its status counts and status),
  // the needs-you cards and the in-progress cards, together.
  const [planR, cards, inProg, boards, allCards, subagents] = await Promise.all([
    call('GET', `/api/plans/${connectedId}`),
    call('GET', `/api/plans/${connectedId}/cards`, { query: { bucket: NEEDS_YOU_BUCKET_ID, sort: 'priority', order: 'desc', limit: MAX_CARDS } }),
    call('GET', `/api/plans/${connectedId}/cards`, { query: { bucket: 'in-progress', sort: 'priority', order: 'desc', limit: MAX_CARDS } }),
    // DX-4448: the board prefixes, for the card links in assistant replies (GET /api/boards, boards.view: every
    // non-archived board of the caller's team, each with `issue_prefix`). Read here, never at draw time.
    call('GET', '/api/boards'),
    // DX-4448: every card id of the plan, whatever its board or status: the plan route is not board-scoped by the MCP (route-board-scope
    // lists `/api/plans/:planId/cards` as false; GET /api/issues would be stamped with the session's board and miss a plan's other
    // boards) and, with no `limit`, answers every row (rows come whole: the route takes no `fields`).
    call('GET', `/api/plans/${connectedId}/cards`),
    // DX-4499: the sub-agents of the plan's live sessions: its own state, so a failed read leaves the plan view `ready`.
    loadSubagents(call, connectedId),
  ])
  const fail = (error: string): PlanView => ({ ...EMPTY, ...noPlan, phase: 'error', error })
  if (!planR.ok) return fail(errText(planR))
  const breakdown = readBreakdown(planR.body?.status_breakdown)
  if (breakdown === null || typeof planR.body?.status !== 'string') {
    return fail(`GET /api/plans/${connectedId} answered no valid status_breakdown (all six statuses as numbers) and status: cannot show progress`)
  }
  const connected: ConnectedPlan = {
    id: connectedId,
    ref: `PLAN-${connectedId}`,
    name: session.plan_name ?? '',
    status: planR.body.status,
    dashboardUrl,
  }
  const base = { dashboardUrl, connected, plans, listener, cardsTotal: 0, cardsRead: 0, plansUnread, statusBreakdown: breakdown, links: readLinks(boards, allCards, connectedId, planR.body.card_count) }

  if (!cards.ok) return { ...EMPTY, ...base, phase: 'error', error: errText(cards) }
  if (typeof cards.body.total !== 'number') {
    return { ...EMPTY, ...base, phase: 'error', error: `GET /api/plans/${connectedId}/cards answered no total: cannot tell whether the card list is complete` }
  }
  const rows: { id: string; priority: number }[] = (cards.body.cards ?? []).map((c: any) => ({
    id: c.id,
    priority: c.priority ?? 0,
  }))
  const fetched = await Promise.all(
    rows.map(async row => ({
      row,
      r: await call('GET', `/api/issues/${row.id}`, { query: { fields: { problems: true } } }),
    })),
  )
  // DX-4458: a card that cannot be read is one line naming it, never the whole pane; the other cards still show.
  const cardErrors: string[] = []
  const cardProblems: ProblemRow[][] = []
  for (const f of fetched) {
    if (f.r.ok) cardProblems.push(toProblems(f.r.body, f.row.priority))
    else cardErrors.push(`Couldn't load ${f.row.id}: ${failureReason(f.r)}`)
  }
  // cards arrive priority-sorted; keep that order
  const problems: ProblemRow[] = await Promise.all(cardProblems.flat().map(p => (p.id === expandedId ? withDetail(call, p) : p)))

  // The in-progress bucket: the same completeness rule, and a readable agent name per row (the cards
  // route carries only the raw session id of a claimed card).
  if (!inProg.ok) return { ...EMPTY, ...base, phase: 'error', error: errText(inProg) }
  if (typeof inProg.body.total !== 'number') {
    return { ...EMPTY, ...base, phase: 'error', error: `GET /api/plans/${connectedId}/cards (in-progress) answered no total: cannot tell whether the list is complete` }
  }
  const ipRows: any[] = inProg.body.cards ?? []
  const named = await Promise.all(ipRows.map(async row => ({ row, r: await call('GET', `/api/issues/${row.id}`, { query: { fields: { assigned_agent_name: true } } }) })))
  for (const n of named) if (!n.r.ok) cardErrors.push(`Couldn't load who is working on ${n.row.id}: ${failureReason(n.r)}`)
  const inProgress: InProgressRow[] = named.map(n => ({
    id: n.row.id,
    title: n.row.title,
    agent: n.r.ok ? (n.r.body.assigned_agent_name ?? null) : null,
    updatedAt: n.row.updatedAt,
  }))
  return {
    ...EMPTY,
    ...base,
    phase: 'ready',
    error: null,
    problems,
    cardErrors,
    cardsTotal: cards.body.total,
    // DX-4458: only the cards read: an unread card makes the problem list a lower bound, as a cap does
    cardsRead: cardProblems.length,
    inProgress,
    inProgressTotal: inProg.body.total,
    subagents,
    refreshedAt,
  }
}

// DX-4499: the sub-agents of every live session on the plan (GET /api/plan-sessions, newest activity first, the pane's own session
// among them), one read each (GET /api/plan-sessions/:sessionId/subagents, DX-4498), each row carrying its session's id (DX-4508: the
// live numbers lay over this session's own rows). A read
// that fails is one line naming what could not be read; the other sessions' rows still show. Signed-out and revoked answers are
// `guarded`'s: they end the whole load before they reach here.
async function loadSubagents(call: Call, planId: number): Promise<SubagentsView> {
  const list = await call('GET', '/api/plan-sessions', { query: { plan_id: planId, live: true, limit: MAX_SESSIONS } })
  const unreadable = (what: string, detail: string): SubagentsView => ({ rows: [], errors: [`Couldn't read ${what}: ${detail}`], sessionsCapped: false, unavailable: false })
  if (!list.ok) return unreadable("the plan's sessions", failureReason(list))
  const sessions: unknown = list.body?.sessions
  if (!Array.isArray(sessions)) return unreadable("the plan's sessions", 'the dashboard sent no list of them')
  if (!sessions.every(s => typeof s?.session_id === 'string' && typeof s?.title === 'string')) {
    return unreadable("the plan's sessions", 'the dashboard sent a session with no id or title')
  }
  const reads = await Promise.all(
    sessions.map(async s => ({ s, r: await call('GET', `/api/plan-sessions/${s.session_id}/subagents`) })),
  )
  const rows: SubagentRow[] = []
  const errors: string[] = []
  const sessionsCapped = sessions.length >= MAX_SESSIONS
  // DX-4499: a dashboard that predates DX-4498 answers 404 to the sub-agents route of EVERY session it lists. That is the route
  // missing, not a session failing, so it is one quiet line (`unavailable`), never one warning per session. A 404 for only some
  // sessions is a real failure of those, and stays a line each.
  if (reads.length > 0 && reads.every(({ r }) => r.status === 404)) return { rows: [], errors: [], sessionsCapped, unavailable: true }
  for (const { s, r } of reads) {
    const named = `the sub-agents of "${s.title}"`
    if (!r.ok) {
      errors.push(`Couldn't read ${named}: ${failureReason(r)}`)
      continue
    }
    const raw: unknown = r.body?.subagents
    if (!Array.isArray(raw)) {
      errors.push(`Couldn't read ${named}: the dashboard sent no list of them`)
      continue
    }
    const shaped = raw.map(x => toSubagent(x, s.session_id))
    const bad = shaped.find((x): x is string => typeof x === 'string')
    if (bad !== undefined) errors.push(`Couldn't read ${named}: ${bad}`)
    else rows.push(...(shaped as SubagentRow[]))
  }
  const looped = parentLoop(rows)
  if (looped !== null) return { rows: [], errors: [...errors, `Couldn't draw the sub-agents: ${looped} is its own ancestor`], sessionsCapped, unavailable: false }
  return { rows, errors, sessionsCapped, unavailable: false }
}

// DX-4448: the link data, or the one reason it could not be read. A failure here is the links' own state: the plan view stays
// `ready` (the plan itself was read), the pane says why replies are not linked, and replies are drawn as written.
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

// DX-4374: the event bridge's state and next step; null when the answer carries none (the server answers null for
// a session on no plan); MALFORMED_LISTENER when one is present but not the server's shape.
const MALFORMED_LISTENER = Symbol('malformed sessionListenerAttached')
function readListener(raw: any): ListenerStatus | null | typeof MALFORMED_LISTENER {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || typeof raw.state !== 'string') return MALFORMED_LISTENER
  if (raw.nextStep !== null && typeof raw.nextStep !== 'string') return MALFORMED_LISTENER
  return { state: raw.state, nextStep: raw.nextStep }
}
