import type { CommentRow, PlanRow, PlanView, ProblemRow, SolutionRow, StepRow } from '../../types'
import { EMPTY } from './config'

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
          .map((c): CommentRow => ({ id: c.id, author: c.author ?? '', at: c.timestamp, text: c.text ?? '' })),
      }),
    )
}

export async function loadPlan(call: Call, refreshedAt: string): Promise<PlanView> {
  const list = await call('GET', '/api/plans', { query: { limit: 30 } })
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
  const connectedPlanId: number | null = list.body.session?.plan_id ?? null
  const listener: string | null = list.body.sessionListenerAttached?.state ?? null
  const base = { connectedPlanId, plans, listener }

  let problems: ProblemRow[] = []
  if (connectedPlanId !== null) {
    const cards = await call('GET', `/api/plans/${connectedPlanId}/cards`, {
      query: { bucket: 'needs-you', sort: 'priority', limit: 15 },
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
  }

  return { ...base, phase: 'ready', error: null, problems, refreshedAt }
}

export function statusText(v: PlanView): string | undefined {
  if (v.phase === 'error') return 'plan: error'
  if (v.phase === 'loading' || v.phase === 'no-mcp') return undefined
  if (v.connectedPlanId === null) return 'plan: not connected'
  const plan = v.plans.find(p => p.id === v.connectedPlanId)
  const n = v.problems.length
  return `plan: ${plan?.ref ?? `PLAN-${v.connectedPlanId}`}${n ? ` · ${n} open problem${n === 1 ? '' : 's'}` : ''}`
}
