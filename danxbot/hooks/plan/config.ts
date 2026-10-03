import type { PlanView } from '../../types'

export const PANE = 'danx-plan'
export const COMMAND = 'danx-plan'
export const SERVER = 'danx-dashboard'
// Known limit: the dashboard origin is hard-coded, so a plugin install on another deployment would
// open the wrong site (a follow-up card makes it come from the session).
export const DASHBOARD = 'https://danxbot.sageus.ai'
export const POLL_MS = 60_000
export const MIN_GAP_MS = 10_000

// How much one load reads. Past a cap the view says so (cardsTotal vs cardsRead, moreComments)
// rather than presenting a lower bound as the whole.
export const MAX_PLANS = 30
export const MAX_CARDS = 15

// A refresh lock held longer than this is a dead load's, not a running one's.
export const LOCK_STALE_MS = 120_000

// At session start the MCP server may not be connected yet: a no-mcp first load is retried after
// each of these waits (clock-driven) before the view settles on no-mcp.
export const NO_MCP_RETRY_MS = [2_000, 5_000, 15_000]

// Truncation lengths, each for one place.
export const BAND_PLAN_NAME_MAX = 50
export const PICKER_PLAN_NAME_MAX = 60
export const CARD_TITLE_MAX = 80
export const TOAST_ERROR_MAX = 160
export const CONNECT_ERROR_MAX = 200
export const CALL_ERROR_MAX = 200
export const ERROR_BODY_MAX = 200
export const OUTPUT_EXCERPT_MAX = 80

// How long the short browser-open toasts stay (the default is 4000).
export const BROWSER_TOAST_MS = 2_500

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
  plansUnread: 0,
  statusBreakdown: null,
  inProgress: [],
  inProgressTotal: 0,
  listener: null,
  refreshedAt: null,
}

// What `busy` holds while writes are under way: a list of keys, one per connect or problem, so
// two different problems can be answered at once and the same one cannot be answered twice.
export const busyKey = {
  connect: (planId: number) => `connect:${planId}`,
  problem: (problemId: number) => `problem:${problemId}`,
  browser: 'browser:open',
  isOpeningBrowser: (busy: string[]) => busy.includes('browser:open'),
  disconnect: (planId: number) => `disconnect:${planId}`,
  isDisconnecting: (busy: string[]) => busy.some(k => k.startsWith('disconnect:')),
  isConnecting: (busy: string[]) => busy.some(k => k.startsWith('connect:')),
  isSaving: (busy: string[], problemId: number) => busy.includes(`problem:${problemId}`),
}

export function planUrl(planId: number): string {
  return `${DASHBOARD}/plans/${planId}`
}

// The one builder of a card's page: problem links are built on it.
export function cardUrl(planId: number, cardId: string): string {
  return `${planUrl(planId)}/cards/${cardId}`
}

// The donut's size in px (Svg takes CSS pixels): the band line's, and the quick view's.
export const DONUT_BAND_PX = 16
export const DONUT_QUICK_PX = 44
