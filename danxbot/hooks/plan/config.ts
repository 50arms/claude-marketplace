import type { PlanView } from '../../types'

export const PANE = 'danx-plan'
export const COMMAND = 'danx-plan'
export const SERVER = 'danx-dashboard'
export const DASHBOARD = 'https://danxbot.sageus.ai'
export const POLL_MS = 60_000
export const MIN_GAP_MS = 10_000

// How much one load reads. Past a cap the view says so (cardsTotal vs cardsRead, moreComments)
// rather than presenting a lower bound as the whole.
export const MAX_PLANS = 30
export const MAX_CARDS = 15

// Truncation lengths, each for one place.
export const BAND_PLAN_NAME_MAX = 50
export const PICKER_PLAN_NAME_MAX = 60
export const CARD_TITLE_MAX = 80
export const TOAST_ERROR_MAX = 160
export const CONNECT_ERROR_MAX = 200
export const CALL_ERROR_MAX = 200

// What the fallback toast puts between its reason and the model row it could not append.
export const NOTE_MARKER = ' | It was to read: '

// Colours standing in for the React app's tokens: accent (recommended),
// success (connected / for), danger (action required / against), warning (open question).
export const ACCENT = 'cyan'
export const SUCCESS = 'green'
export const DANGER = 'red'
export const WARNING = 'yellow'

export const EMPTY: PlanView = {
  phase: 'loading',
  error: null,
  connected: null,
  plans: [],
  problems: [],
  cardsTotal: 0,
  cardsRead: 0,
  listener: null,
  refreshedAt: null,
}

// What `busy` holds while a write is under way: one writer per key.
export const busyKey = {
  connect: (planId: number) => `connect:${planId}`,
  problem: (problemId: number) => `problem:${problemId}`,
  isConnecting: (busy: string | null) => busy?.startsWith('connect:') ?? false,
  isSaving: (busy: string | null, problemId: number) => busy === `problem:${problemId}`,
}

export function planUrl(planId: number): string {
  return `${DASHBOARD}/plans/${planId}`
}
