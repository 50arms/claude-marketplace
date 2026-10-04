import type { SubagentCard, SubagentRow, SubagentState } from '../../types'

// DX-4499: the Sub-agents section's data. Pure (no `$`, no call): load.ts reads, this shapes and orders, subagent-cards.tsx draws.

const MALFORMED = Symbol('malformed card')
const STATES: readonly SubagentState[] = ['running', 'done', 'failed', 'stopped']

const isString = (v: unknown): v is string => typeof v === 'string'
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

// One row of `GET /api/plan-sessions/:sessionId/subagents` (danxbot's plan_session_subagent resource), or the one reason it cannot
// be read. Every field the card draws is checked: a row the pane cannot draw truthfully is an error line, never a guessed value.
export function toSubagent(raw: any, sessionId: string, sessionTitle: string): SubagentRow | string {
  if (raw === null || typeof raw !== 'object') return 'a row that is not an object'
  if (!isString(raw.id)) return 'a row with no id'
  const at = (what: string) => `${raw.id} has no valid ${what}`
  if (!STATES.includes(raw.state)) return at('state')
  if (!isCount(raw.started_at)) return at('started_at')
  if (raw.state === 'running' ? raw.finished_at !== null : !isCount(raw.finished_at)) return at('finished_at for its state')
  if (raw.state === 'running' ? raw.visible_until !== null : !isCount(raw.visible_until)) return at('visible_until for its state')
  if (!isNullableString(raw.parent_id) || raw.parent_id === raw.id) return at('parent_id')
  if (!isNullableString(raw.description)) return at('description')
  if (!isNullableString(raw.agent_type) || !isNullableString(raw.model) || !isNullableString(raw.effort)) return at('agent_type, model and effort')
  if (!isCount(raw.tokens_total) || !isCount(raw.cost_usd) || !isCount(raw.tool_call_count)) return at('tokens_total, cost_usd and tool_call_count')
  if (!isNullableString(raw.current_activity)) return at('current_activity')
  const card = readCard(raw.card)
  if (card === MALFORMED) return at('card')
  return {
    id: raw.id,
    sessionId,
    sessionTitle,
    parentId: raw.parent_id,
    label: raw.description,
    agentType: raw.agent_type,
    model: raw.model,
    effort: raw.effort,
    state: raw.state,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    visibleUntil: raw.visible_until,
    tokensTotal: raw.tokens_total,
    costUsd: raw.cost_usd,
    toolCalls: raw.tool_call_count,
    activity: raw.current_activity,
    card,
  }
}

function readCard(raw: any): SubagentCard | null | typeof MALFORMED {
  if (raw === null) return null
  if (raw === undefined || typeof raw !== 'object') return MALFORMED
  if (!isString(raw.id) || !isString(raw.title) || (raw.via !== 'claim' && raw.via !== 'brief')) return MALFORMED
  return { id: raw.id, title: raw.title, via: raw.via }
}

// The rows a session's chain of parents loops through, or null: a loop is never drawn (a card inside itself), so it is an error.
export function parentLoop(rows: readonly SubagentRow[]): string | null {
  const byId = new Map(rows.map(r => [r.id, r]))
  for (const row of rows) {
    let at: SubagentRow | undefined = row
    for (let step = 0; at !== undefined && at.parentId !== null; step++) {
      if (step > rows.length) return row.id
      at = byId.get(at.parentId)
    }
  }
  return null
}

// What the pane shows at `now`: a running row, and an ended one until the moment the server says it drops (`visibleUntil`, on this
// pane's own clock: nothing publishes that moment).
export function visibleSubagents(rows: readonly SubagentRow[], now: number): SubagentRow[] {
  return rows.filter(r => r.state === 'running' || (r.visibleUntil as number) > now)
}

// One card and the cards of the sub-agents it spawned, drawn inside it.
export type SubagentNode = { row: SubagentRow; children: SubagentNode[] }

// Running first (oldest start first), then the ended ones, newest finish first. The one order at every level.
function byRecency(a: SubagentRow, b: SubagentRow): number {
  if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1
  if (a.state === 'running') return a.startedAt - b.startedAt || a.id.localeCompare(b.id)
  return (b.finishedAt as number) - (a.finishedAt as number) || a.id.localeCompare(b.id)
}

// The rows as a forest by `parentId`. A row whose parent is not in `rows` (it dropped off, or its session is not read) is a root.
// `rows` has no parent loop (parentLoop), so every row is reached from a root.
export function nestSubagents(rows: readonly SubagentRow[]): SubagentNode[] {
  const ids = new Set(rows.map(r => r.id))
  const children = new Map<string, SubagentRow[]>()
  const roots: SubagentRow[] = []
  for (const row of rows) {
    if (row.parentId !== null && ids.has(row.parentId)) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row])
    else roots.push(row)
  }
  const build = (row: SubagentRow): SubagentNode => ({ row, children: (children.get(row.id) ?? []).sort(byRecency).map(build) })
  return roots.sort(byRecency).map(build)
}

// "38s", "4m 12s", "1h 05m": a runtime. A clock set back never shows a negative one.
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// How long the sub-agent ran: counted up from its start while it runs (the server answers none then), its own span once ended.
export function runtime(row: SubagentRow, now: number): string {
  return duration((row.finishedAt ?? now) - row.startedAt)
}

// "950", "12.3k", "4.6M": one decimal under ten of the unit, none above it; a count that rounds up to the next unit reads in it.
export function compactCount(n: number): string {
  if (n < 1_000) return String(n)
  const unit = (value: number, suffix: string) => `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)}${suffix}`
  const k = n / 1_000
  if (Math.round(k) < 1_000) return unit(k, 'k')
  return unit(n / 1_000_000, 'M')
}

// "$0.42"; a cost under a cent reads "<$0.01" (never "$0.00" for work that cost something).
export function dollars(usd: number): string {
  if (usd === 0) return '$0.00'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}
