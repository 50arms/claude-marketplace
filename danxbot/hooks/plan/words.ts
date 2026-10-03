import type { PlanView, StatusBreakdown } from '../../types'
import { BAND_PLAN_NAME_MAX } from './config'

// The browser's wording, per problem type (frontend/src/routes/board/card/problem-vocabulary.ts).
export const WORDS = {
  question: {
    recommended: 'Recommended',
    body: 'Description',
    proCon: 'For and against',
    pro: 'For',
    con: 'Against',
    use: 'Use this',
    useNote: 'This but…',
    freeform: 'Or answer in your own words…',
    send: 'Send answer',
  },
  action: {
    recommended: 'Start here',
    body: 'What taking this route involves',
    proCon: 'Why this route',
    pro: 'Pick this when',
    con: 'Watch out for',
    use: 'Mark done',
    useNote: 'Mark done, with a note',
    freeform: 'Or say how you did it your own way…',
    send: 'Record it',
  },
} as const

export function age(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// "+" when the view read fewer needs-you cards than the dashboard has: every count of open problems is then a
// lower bound. The one home of that rule.
export function capMark(v: PlanView): string {
  return v.cardsTotal > v.cardsRead ? '+' : ''
}

// "3 open problems", "3+ open problems" when the view read fewer cards than exist, '' for none.
export function problemCount(v: PlanView): string {
  const n = v.problems.length
  if (n === 0) return ''
  const more = capMark(v)
  return `${n}${more} open problem${n === 1 && !more ? '' : 's'}`
}

// What the pane says when it read fewer cards than the dashboard has.
export function cappedNote(v: PlanView): string | null {
  const unread = v.cardsTotal - v.cardsRead
  return unread > 0 ? `+${unread} more card${unread === 1 ? '' : 's'} with open problems in the browser` : null
}

// "+3 more plans in the browser" when the plan list was capped.
export function cappedPlansNote(v: PlanView): string | null {
  return v.plansUnread > 0 ? `+${v.plansUnread} more plan${v.plansUnread === 1 ? '' : 's'} in the browser` : null
}

// "Updated 08:15:42Z": the UTC clock part of an ISO timestamp.
export function updatedText(iso: string): string {
  const [, time = ''] = iso.split('T')
  return `Updated ${time.slice(0, 8)}Z`
}

// The band's label for a view that is not the Plan-button-only one.
export function bandLabel(v: PlanView): string {
  if (v.phase === 'error') return 'plan: error'
  if (v.phase === 'loading' && !v.refreshedAt) return 'plan: loading…'
  if (!v.connected) return 'Not connected to a plan'
  const count = problemCount(v)
  return [v.connected.ref, v.connected.name.slice(0, BAND_PLAN_NAME_MAX), count].filter(Boolean).join(' · ')
}

// Percent complete, as the dashboard's plan header computes it. Mirrors the formula written inline at
// danxbot's frontend/src/routes/plans/PlanStatusSummary.tsx:202 (the total) and :218 (the percent) (DX-3766):
// total = In Progress + ToDo + Backlog + Review + Done (Cancelled is NOT counted);
// percent = total > 0 ? Math.round(Done / total * 100) : 0. The two must never disagree.
export function planPercent(b: StatusBreakdown): number {
  const total = b['In Progress'] + b.ToDo + b.Backlog + b.Review + b.Done
  return total > 0 ? Math.round((b.Done / total) * 100) : 0
}

// The text donut for a percent: ○ 0, ◔ 1-37, ◑ 38-62, ◕ 63-99, ● 100.
export function donutGlyph(percent: number): string {
  if (percent <= 0) return '○'
  if (percent <= 37) return '◔'
  if (percent <= 62) return '◑'
  if (percent < 100) return '◕'
  return '●'
}

// A connected, LOADED view's percent; null otherwise. An error view keeps the last plan's fields, so only a
// ready view may draw a figure: nothing derived from loaded data shows under an error.
export function viewPercent(v: PlanView): number | null {
  return v.phase === 'ready' && v.connected && v.statusBreakdown ? planPercent(v.statusBreakdown) : null
}

// Open problems split into questions and actions: one count for the pane and the quick view.
export function problemSplit(v: PlanView): { questions: number; actions: number } {
  const actions = v.problems.filter(p => p.type === 'action').length
  return { questions: v.problems.length - actions, actions }
}

// The footer entry's label (the `SessionMode` button); null where the footer shows nothing (loading,
// no MCP server). Replaces the plain status text: there is no second label builder.
export function footerLabel(v: PlanView): string | null {
  if (v.phase === 'error') return 'plan: error'
  if (v.phase === 'loading' || v.phase === 'no-mcp') return null
  const percent = viewPercent(v)
  if (!v.connected || percent === null) return 'plan: not connected'
  const open = v.problems.length > 0 ? ` · ${v.problems.length}${capMark(v)} open` : ''
  return `${donutGlyph(percent)} ${percent}% · ${v.connected.ref}${open}`
}

// "+N more cards in progress in the browser" when the in-progress bucket was capped.
export function cappedInProgressNote(v: PlanView): string | null {
  const unread = v.inProgressTotal - v.inProgress.length
  return unread > 0 ? `+${unread} more in-progress card${unread === 1 ? '' : 's'} in the browser` : null
}
