import type { CommentRow, ConnectedPlan, PlanRow, PlanView, ProblemRow, SolutionRow, StepRow } from '../../types'
import { EMPTY, MAX_CARDS, MAX_PLANS } from './config'

// `$` cannot be passed across an import (`claude plugin validate`), so everything here is pure:
// the dashboard call arrives as `call`, built from `$.mcp.call` in register.tsx.
export type Api = { ok: boolean; status: number; body: any; unreachable?: boolean }
export type Call = (method: string, path: string, extra?: { query?: object; body?: object }) => Promise<Api>

export function errText(r: Api): string {
  const b = r.body ?? {}
  return `${r.status || 'mcp'}: ${b.message ?? b.error ?? JSON.stringify(b).slice(0, 200)}`
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
  const moreComments = Math.max(0, (card.comments_page?.total ?? comments.length) - comments.length)
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

  const plans: PlanRow[] = (list.body.plans ?? [])
    .filter((p: any) => !p.archived_at)
    .map((p: any) => ({
      id: p.id,
      ref: p.ref,
      name: p.name,
      status: p.status,
      needsYou: p.bucket_counts?.['needs-you'] ?? 0,
    }))
  // The connected plan comes from the session in this same response, not from the capped list.
  const session = list.body.session
  const connected: ConnectedPlan | null =
    session?.plan_id == null
      ? null
      : {
          id: session.plan_id,
          ref: `PLAN-${session.plan_id}`,
          name: session.plan_name ?? '',
          status: plans.find(p => p.id === session.plan_id)?.status ?? null,
        }
  const listener: string | null = list.body.sessionListenerAttached?.state ?? null
  const base = { connected, plans, listener, cardsTotal: 0, cardsRead: 0 }

  let problems: ProblemRow[] = []
  if (connected) {
    const cards = await call('GET', `/api/plans/${connected.id}/cards`, {
      query: { bucket: 'needs-you', sort: 'priority', limit: MAX_CARDS },
    })
    if (!cards.ok) return { ...EMPTY, ...base, phase: 'error', error: errText(cards) }
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
    // cards arrive priority-sorted; keep that order
    problems = fetched.flatMap(f => toProblems(f.r.body, f.row.priority))
    return { ...base, phase: 'ready', error: null, problems, cardsTotal: cards.body.total ?? rows.length, cardsRead: rows.length, refreshedAt }
  }

  return { ...base, phase: 'ready', error: null, problems, refreshedAt }
}
