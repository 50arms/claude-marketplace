import type { ConnectedPlan, PlanView } from '../../types'

export const PANE = 'danx-plan'
// DX-4419: the name every footer and pane label, and the band's not-connected, loading and disconnected states, carry,
// so the operator can tell the text is danxbot's.
export const BRAND = 'Danxbot'
export const PLAN_TITLE = `${BRAND} Plan`
// DX-4420: the problem icon on the band's count button (a Button label is text only).
export const PROBLEM_GLYPH = '⚠'
export const COMMAND = 'danx-plan'
export const SERVER = 'danx-dashboard'
export const POLL_MS = 60_000
export const MIN_GAP_MS = 10_000

// The dashboard's six card statuses, in the order a view's breakdown is read.
export const STATUS_KEYS = ['In Progress', 'ToDo', 'Backlog', 'Review', 'Done', 'Cancelled'] as const

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
// DX-4420: the band's plan name is cut to the columns the band has left after its controls (band.tsx), never to a fixed
// length. The widths below are what that budget assumes: the indicator, the `[ label ]` chrome and the gap per control,
// the shortest name worth drawing, and a spare column so a measuring error never pushes a control off the edge.
export const BAND_INDICATOR_COLS = 2
export const BAND_CONTROL_CHROME_COLS = 4
export const BAND_GAP_COLS = 1
export const BAND_NAME_MIN_COLS = 4
export const BAND_SPARE_COLS = 2
export const PICKER_PLAN_NAME_MAX = 60
export const CARD_TITLE_MAX = 80
export const TOAST_ERROR_MAX = 160
export const CONNECT_ERROR_MAX = 200
export const CALL_ERROR_MAX = 200
export const ERROR_BODY_MAX = 200
export const OUTPUT_EXCERPT_MAX = 80

// How long the short browser-open toasts stay (the default is 4000).
export const BROWSER_TOAST_MS = 2_500

// DX-4391: the host caps a toast at 60 s; the approval toast carries the confirm code the person compares with the page.
export const APPROVAL_TOAST_MS = 60_000

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

// DX-4317: every link is built on the origin the plan list answered (`dashboard_url`), carried on the
// connected plan: there is no origin constant, so a link always opens the dashboard the data came from.
export function planUrl(plan: ConnectedPlan): string {
  return `${plan.dashboardUrl}/plans/${plan.id}`
}

// DX-4420: the plan page's Needs You tab, which the band's problem button opens. `needs-you` is danxbot's
// NEEDS_YOU_BUCKET.id (frontend/src/lib/plan-buckets.ts), read by PlanDetailScreen from `?tab=`.
export const NEEDS_YOU_BUCKET_ID = 'needs-you'
export function needsYouUrl(plan: ConnectedPlan): string {
  return `${planUrl(plan)}?tab=${NEEDS_YOU_BUCKET_ID}`
}

// The one builder of a card's page: problem links are built on it.
export function cardUrl(plan: ConnectedPlan, cardId: string): string {
  return `${planUrl(plan)}/cards/${cardId}`
}

// The donut's size in px (Svg takes CSS pixels): the band line's, and the pane header's.
export const DONUT_BAND_PX = 16
export const DONUT_PANE_PX = 44

// DX-4374: what the pane's event line says for a connected session the server reports no event bridge for
// (`sessionListenerAttached` null): the plugin knows only that no status came, so it says that; never green, never silent.
export const NO_EVENT_BRIDGE = 'the dashboard sent no event bridge status for this session'
