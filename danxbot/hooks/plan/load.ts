import type { CommentRow, ConnectedPlan, InProgressRow, PlanRow, PlanView, ProblemRow, SolutionRow, StatusBreakdown, StepRow } from '../../types'
import { EMPTY, ERROR_BODY_MAX, MAX_CARDS, MAX_PLANS, STATUS_KEYS } from './config'

// `$` cannot be passed across an import (`claude plugin validate`), so everything here is pure:
// the dashboard call arrives as `call`, built from `$.mcp.call` in register.tsx.
export type Api = { ok: boolean; status: number; body: any; unreachable?: boolean }
export type Call = (method: string, path: string, extra?: { query?: object; body?: object }) => Promise<Api>

export function errText(r: Api): string {
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

export function toProblems(card: any, priority: number): ProblemRow[] {
  const comments: any[] = card.comments ?? []
  // The API pages a card's comments (comments_page.total counts them all).
  const moreComments = Math.max(0, card.comments_page.total - comments.length)
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
        solutions: (p.solutions ?? [])
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
          .sort((a: SolutionRow, b: SolutionRow) => Number(b.recommended) - Number(a.recommended)),
        comments: comments
          .filter(c => c.problem_id === p.id)
          .map((c): CommentRow => ({ id: String(c.id), author: c.author ?? '', at: c.timestamp, text: c.text ?? '' })),
        moreComments,
      }),
    )
}

export async function loadPlan(call: Call, refreshedAt: string): Promise<PlanView> {
  const list = await call('GET', '/api/plans', { query: { limit: MAX_PLANS } })
  if (list.unreachable) return { ...EMPTY, phase: 'no-mcp' }
  if (!list.ok) return { ...EMPTY, phase: 'error', error: errText(list) }

  // A paged route that does not say how many there are cannot be read as complete.
  if (typeof list.body.total !== 'number') {
    return { ...EMPTY, phase: 'error', error: 'GET /api/plans answered no total: cannot tell whether the plan list is complete' }
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
      needsYou: p.bucket_counts?.['needs-you'] ?? 0,
    }))
  // The session in this same response says WHICH plan; the plan itself is read by id below.
  const session = list.body.session
  const connectedId: number | null = session?.plan_id ?? null
  const listener: string | null = list.body.sessionListenerAttached?.state ?? null
  const noPlan = { connected: null, plans, listener, cardsTotal: 0, cardsRead: 0, plansUnread }
  if (connectedId === null) return { ...EMPTY, ...noPlan, phase: 'ready', error: null, refreshedAt }

  // One load of everything about the connected plan: the plan itself (its status counts and status),
  // the needs-you cards and the in-progress cards, together.
  const [planR, cards, inProg] = await Promise.all([
    call('GET', `/api/plans/${connectedId}`),
    call('GET', `/api/plans/${connectedId}/cards`, { query: { bucket: 'needs-you', sort: 'priority', limit: MAX_CARDS } }),
    call('GET', `/api/plans/${connectedId}/cards`, { query: { bucket: 'in-progress', sort: 'priority', limit: MAX_CARDS } }),
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
  }
  const base = { connected, plans, listener, cardsTotal: 0, cardsRead: 0, plansUnread, statusBreakdown: breakdown }

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
      r: await call('GET', `/api/issues/${row.id}`, {
        query: { fields: { problems: { solutions: { steps: true } }, comments: true } },
      }),
    })),
  )
  // A card that cannot be read fails the whole load: a pane that silently drops a card's
  // problems would tell the operator nothing needs them.
  const failed = fetched.find(f => !f.r.ok)
  if (failed) return { ...EMPTY, ...base, phase: 'error', error: `${failed.row.id} ${errText(failed.r)}` }
  // a card's comments are paged: without comments_page.total they cannot be read as complete
  const unpaged = fetched.find(f => typeof f.r.body.comments_page?.total !== 'number')
  if (unpaged) {
    return { ...EMPTY, ...base, phase: 'error', error: `GET /api/issues/${unpaged.row.id} answered no comments_page.total: cannot tell whether its comments are complete` }
  }
  // cards arrive priority-sorted; keep that order
  const problems: ProblemRow[] = fetched.flatMap(f => toProblems(f.r.body, f.row.priority))

  // The in-progress bucket: the same completeness rule, and a readable agent name per row (the cards
  // route carries only the raw session id of a claimed card).
  if (!inProg.ok) return { ...EMPTY, ...base, phase: 'error', error: errText(inProg) }
  if (typeof inProg.body.total !== 'number') {
    return { ...EMPTY, ...base, phase: 'error', error: `GET /api/plans/${connectedId}/cards (in-progress) answered no total: cannot tell whether the list is complete` }
  }
  const ipRows: any[] = inProg.body.cards ?? []
  const named = await Promise.all(ipRows.map(async row => ({ row, r: await call('GET', `/api/issues/${row.id}`) })))
  const unnamed = named.find(n => !n.r.ok)
  if (unnamed) return { ...EMPTY, ...base, phase: 'error', error: `${unnamed.row.id} ${errText(unnamed.r)}` }
  const inProgress: InProgressRow[] = named.map(n => ({
    id: n.row.id,
    title: n.row.title,
    agent: n.r.body.assigned_agent_name ?? null,
    updatedAt: n.row.updatedAt,
  }))
  return {
    ...base,
    phase: 'ready',
    error: null,
    problems,
    cardsTotal: cards.body.total,
    cardsRead: rows.length,
    inProgress,
    inProgressTotal: inProg.body.total,
    refreshedAt,
  }
}

// All six statuses as numbers, or null: a missing count is an error state, never a guessed 0%.
function readBreakdown(raw: any): StatusBreakdown | null {
  if (raw === null || typeof raw !== 'object') return null
  for (const key of STATUS_KEYS) if (typeof raw[key] !== 'number') return null
  return { 'In Progress': raw['In Progress'], ToDo: raw.ToDo, Backlog: raw.Backlog, Review: raw.Review, Done: raw.Done, Cancelled: raw.Cancelled }
}
