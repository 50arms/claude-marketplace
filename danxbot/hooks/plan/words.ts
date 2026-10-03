import type { PlanView } from '../../types'
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

// "3 open problems", "3+ open problems" when the view read fewer cards than exist, '' for none.
export function problemCount(v: PlanView): string {
  const n = v.problems.length
  if (n === 0) return ''
  const more = v.cardsTotal > v.cardsRead ? '+' : ''
  return `${n}${more} open problem${n === 1 && !more ? '' : 's'}`
}

// What the pane says when it read fewer cards than the dashboard has.
export function cappedNote(v: PlanView): string | null {
  const unread = v.cardsTotal - v.cardsRead
  return unread > 0 ? `+${unread} more card${unread === 1 ? '' : 's'} with open problems in the browser` : null
}

// The band's label for a view that is not the Plan-button-only one.
export function bandLabel(v: PlanView): string {
  if (v.phase === 'error') return 'plan: error'
  if (v.phase === 'loading' && !v.refreshedAt) return 'plan: loading…'
  if (!v.connected) return 'Not connected to a plan'
  const count = problemCount(v)
  return [v.connected.ref, v.connected.name.slice(0, BAND_PLAN_NAME_MAX), count].filter(Boolean).join(' · ')
}

// The status line.
export function statusText(v: PlanView): string | undefined {
  if (v.phase === 'error') return 'plan: error'
  if (v.phase === 'loading' || v.phase === 'no-mcp') return undefined
  if (!v.connected) return 'plan: not connected'
  const count = problemCount(v)
  return `plan: ${count ? `${v.connected.ref} · ${count}` : v.connected.ref}`
}
