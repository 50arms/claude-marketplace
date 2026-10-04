import type { PlanView, StatusBreakdown } from '../../types'
import { BAND_CONTROL_CHROME_COLS, BAND_GAP_COLS, BAND_INDICATOR_COLS, BAND_NAME_MIN_COLS, BAND_SPARE_COLS, BRAND, PLAN_TITLE, PROBLEM_GLYPH, SIGNED_OUT_LABEL } from './config'

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

// DX-4420: the band button's label: a problem glyph and the count, "3+" when the view read fewer cards than exist,
// '' for none (the button is then not drawn). The count is a button, not label text: see band.tsx.
export function problemBadge(v: PlanView): string {
  const n = v.problems.length
  return n === 0 ? '' : `${PROBLEM_GLYPH} ${n}${capMark(v)}`
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

// `text` cut to `max` characters, the last one an ellipsis, so a cut name never reads as a whole one.
export function ellipsize(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const NAME_SEP = ' · '

// DX-4420: the columns the band's label may take: its width less the indicator and each control. A Button draws `[ label ]`
// chrome on the terminal; a Link none. The terminal's widths are the model (UNVERIFIED on the desktop's native buttons and 16px donut): the spare columns
// are the margin, and the label's own `truncate-end` is the second line of defence.
export function bandLabelCols(columns: number, controls: readonly { label: string; isButton: boolean }[]): number {
  const controlCols = controls.reduce((n, c) => n + c.label.length + (c.isButton ? BAND_CONTROL_CHROME_COLS : 0) + BAND_GAP_COLS, 0)
  // the row's gaps: one per control, one after the indicator, one after the label's spacer
  return columns - BAND_INDICATOR_COLS - 2 * BAND_GAP_COLS - controlCols - BAND_SPARE_COLS
}

// The band's label for a view that is not the Panel-button-only one. `maxCols`: the columns the label may take (absent:
// no limit, the layout truncates); a connected plan's name is cut to what `PLAN-NN · ` leaves, with an ellipsis.
export function bandLabel(v: PlanView, maxCols?: number): string {
  // DX-4423: a session with no key reads signed out, in the operator's words, whatever it was connected to before.
  if (v.phase === 'signed-out') return SIGNED_OUT_LABEL
  // DX-4419: the operator's wording for ANY failed load, even one that kept the connected plan.
  if (v.phase === 'error') return `${PLAN_TITLE}: Disconnected`
  if (v.phase === 'loading' && !v.refreshedAt) return `${PLAN_TITLE}: loading…`
  if (!v.connected) return `${BRAND}: not connected to a plan`
  // DX-4420: a connected band reads `PLAN-NN · name`; the Danxbot prefix stays on the states with no plan.
  const { ref, name } = v.connected
  const sepCols = ref ? NAME_SEP.length : 0
  const nameCols = maxCols === undefined ? name.length : Math.max(BAND_NAME_MIN_COLS, maxCols - ref.length - sepCols)
  return [ref, ellipsize(name, nameCols)].filter(Boolean).join(NAME_SEP)
}

// Percent complete, as the dashboard's plan header computes it. Mirrors the formula written inline at
// danxbot's frontend/src/routes/plans/PlanStatusSummary.tsx:202 (the total) and :218 (the percent) (DX-3766):
// total = In Progress + ToDo + Backlog + Review + Done (Cancelled is NOT counted);
// percent = total > 0 ? Math.round(Done / total * 100) : 0. The two must never disagree.
export function planPercent(b: StatusBreakdown): number {
  const { done, total } = doneTotal(b)
  return total > 0 ? Math.round((done / total) * 100) : 0
}

// DX-4374: the same rule's two whole numbers (the pane shows `done / total`): Done over In Progress + ToDo +
// Backlog + Review + Done, Cancelled excluded. planPercent and the pane both read it, so they never disagree.
export function doneTotal(b: StatusBreakdown): { done: number; total: number } {
  return { done: b.Done, total: b['In Progress'] + b.ToDo + b.Backlog + b.Review + b.Done }
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

// Open problems split into questions and actions: one count for the pane.
export function problemSplit(v: PlanView): { questions: number; actions: number } {
  const actions = v.problems.filter(p => p.type === 'action').length
  return { questions: v.problems.length - actions, actions }
}

// DX-4374: the footer button's label, read from `view.connected` alone (never from the phase's error):
// `Danxbot · PLAN-NN` when a plan is known, `Danxbot` otherwise (DX-4419); null where the footer shows nothing (loading, no MCP).
// The label can flip to `Danxbot` when a plan-list load fails: that error view carries no connected plan (the
// session is read from the same failed answer), so the footer cannot name one. An error built after the plan
// was read keeps it, and the footer keeps `Danxbot · PLAN-NN`.
export function footerLabel(v: PlanView): string | null {
  if (v.phase === 'loading' || v.phase === 'no-mcp') return null
  if (v.phase === 'signed-out') return SIGNED_OUT_LABEL
  return v.connected ? `${BRAND} · ${v.connected.ref}` : BRAND
}

// "+N more cards in progress in the browser" when the in-progress bucket was capped.
export function cappedInProgressNote(v: PlanView): string | null {
  const unread = v.inProgressTotal - v.inProgress.length
  return unread > 0 ? `+${unread} more in-progress card${unread === 1 ? '' : 's'} in the browser` : null
}
