import type { PlanView } from '../../types'

export const PANE = 'danx-plan'
export const COMMAND = 'danx-plan'
export const SERVER = 'danx-dashboard'
export const DASHBOARD = 'https://danxbot.sageus.ai'
export const POLL_MS = 60_000
export const MIN_GAP_MS = 10_000

// Colours standing in for the React app's tokens: accent (recommended),
// success (connected / for), danger (action required / against), warning (open question).
export const ACCENT = 'cyan'
export const SUCCESS = 'green'
export const DANGER = 'red'
export const WARNING = 'yellow'

export const EMPTY: PlanView = {
  phase: 'loading',
  error: null,
  connectedPlanId: null,
  plans: [],
  problems: [],
  listener: null,
  refreshedAt: null,
}

export function planUrl(planId: number): string {
  return `${DASHBOARD}/plans/${planId}`
}
