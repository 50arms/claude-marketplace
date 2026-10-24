import type { ConnectedPlan, PlanView } from '../../types'

// the name every footer label, and the band's not-connected, loading and disconnected states, carry,
// so the operator can tell the text is danxbot's.
export const BRAND = '50 Arms'
// the problem icon on the band's count button (a Button label is text only).
export const PROBLEM_GLYPH = '⚠'
export const COMMAND = 'danx-plan'
// the one dashboard MCP server, the one this plugin ships (plugin.json `mcpServers`): Claude Code names a plugin's server
// `plugin:<plugin>:<server>` (verified live with `claude mcp list`) and its tools `mcp__<server with : as _>__<tool>`. No repo
// declares a `danx-dashboard` server of its own any more, so there is no second name to try.
export const SERVER = 'plugin:danxbot:danx-dashboard'
export const toolName = (tool: string) => `mcp__${SERVER.replace(/:/g, '_')}__${tool}`
export const MIN_GAP_MS = 10_000
// while a permission request is open its claim is polled this often (otherwise never), so the model hears the
// decision within seconds. The server's per-key claim limit (twice one 3 s poll, about
// 0.67 claims a second) fits the MCP's own 3 s poll plus this one for ONE open request; with more open at once the MCP's poll
// alone passes it, and this poll's 429 only keeps the request for the next tick.
export const PERMISSION_POLL_MS = 10_000
// how many decided permission requests the told-once guard ($.store) remembers; ids are unique, so the oldest go first.
export const PERMISSION_TOLD_MAX = 100

// The dashboard's six card statuses, in the order a view's breakdown is read.
export const STATUS_KEYS = ['In Progress', 'ToDo', 'Backlog', 'Review', 'Done', 'Cancelled'] as const

// The in-progress bucket is listed at most this many rows long (a longer bucket is cut, its total still read).
export const IN_PROGRESS_LIMIT = 15
// `GET /api/plans` is asked for one row only because only its `session`, `dashboard_url` and listener fields are read (never the whole list).
export const SESSION_PLAN_PROBE = { limit: 1 }
// `GET /api/plans/:id` is asked, besides its always-present counts (the status breakdown and the bucket counts, whose `needs-you` the band's badge shows),
// for the plan's card ids (an opt-in field, a few bytes per card at any plan size). The band and the reply links need nothing more of a card, and the plan's card-list route answers whole
// card rows (about 3 KB each), which past about 20 cards exceeds the host's tool-result limit.
export const PLAN_BAND_FIELDS = { card_ids: true }
// an issue prefix as a board names it (`ABC`, `XYZ`): capital letters, at most this many. Anything else in a boards
// answer is an error (card-links.ts still escapes them, so a prefix can never change the matcher).
export const PREFIX_MAX = 10
export const PREFIX_PATTERN = new RegExp(`^[A-Z]{1,${PREFIX_MAX}}$`)

// where the session reports its rate-limit windows, and how often it does so before danxbot has said (every answer carries
// `report_every_ms`, the interval the dashboard sets, which the plugin then follows). The tick matters even when nothing moved: an idle
// session's figure freezes at its last response and `session.measure` skips a moved reset time at an unchanged percent.
export const USAGE_PATH = '/api/plan-sessions/me/usage'
export const USAGE_TICK_MS = 60_000
// ... and the shortest cadence the plugin accepts from danxbot: a smaller one is a malformed answer, not a request to report in a loop.
export const MIN_USAGE_TICK_MS = 5_000

// EVERY plan load (the first and each refresh) answers within this or is shown as an error.
export const LOAD_DEADLINE_MS = 30_000
// ... and a load past its deadline is not left running beside the next: its refresh keeps the lock for up to this long more, applies the
// answer if it comes in that time, and gives the call up after it.
export const LOAD_ORPHAN_WAIT_MS = 30_000
// A refresh lock held longer than this is a dead step's, not a running one's: a load holds it for its deadline and the orphan wait at most, so
// what is left to hang is a step after it (a permission claim; the live sync is detached from the refresh, so it cannot hold the lock). The tail is
// what those steps may take after the orphan wait, so a holder that is just finishing is not taken over the moment it lands. A refresh asked past it, forced or not, takes the lock over.
export const LOCK_TAIL_MS = 10_000
export const LOCK_STALE_MS = LOAD_DEADLINE_MS + LOAD_ORPHAN_WAIT_MS + LOCK_TAIL_MS

// At session start the MCP server may not be connected yet: a first load that failed on exactly that is retried after
// each of these waits (clock-driven) before the view settles on the error. (The relay's own start retries: RELAY_START_RETRY_MS.)
export const NOT_CONNECTED_RETRY_MS = [2_000, 5_000, 15_000]
// how often a session start looks for the plugin's own server in the session's tool list, until the start's deadline (CONTEXT_DEADLINE_MS)
export const SERVER_POLL_MS = 500

// Truncation lengths, each for one place.
// the band's plan name is cut to the columns the band has left after its controls (`bandLabelCols` in words.ts), never to a fixed
// length. The widths below are what that budget assumes: the indicator, the `[ label ]` chrome and the gap per control,
// the shortest name worth drawing, and a spare column so a measuring error never pushes a control off the edge.
export const BAND_INDICATOR_COLS = 2
export const BAND_CONTROL_CHROME_COLS = 4
export const BAND_GAP_COLS = 1
export const BAND_NAME_MIN_COLS = 4
export const BAND_SPARE_COLS = 2
export const TOAST_ERROR_MAX = 160
// the longest a failure toast's message is cut to (sign-in, Disconnect and a failed detached task all use it)
export const FAILURE_TOAST_MAX = 200
export const CALL_ERROR_MAX = 200
export const ERROR_BODY_MAX = 200

// the host caps a toast at 60 s; the approval toast carries the confirm code the person compares with the page.
export const APPROVAL_TOAST_MS = 60_000

// What the fallback toast puts between its reason and the model row it could not append.
export const NOTE_MARKER = ' | It was to read: '

// the surface name the app reports for its desktop host (the other is the terminal)
export const DESKTOP_SURFACE = 'desktop'

// Colours standing in for the React app's tokens: success (connected / for), danger (action required / against), warning (open question).
export const SUCCESS = 'green'
export const DANGER = 'red'
export const WARNING = 'yellow'

export const EMPTY: PlanView = {
  phase: 'loading',
  error: null,
  serverNotConnected: false,
  dashboardUrl: null,
  connected: null,
  agent: null,
  card: null,
  agentBlock: null,
  statusBreakdown: null,
  inProgress: [],
  needsYou: 0,
  needsYouError: null,
  pausedUntil: null,
  // nothing to link until a load reads the boards and the plan's cards
  links: { state: 'ready', prefixes: [], planCardIds: [] },
  listener: null,
  agent: null,
  refreshedAt: null,
  resumePlan: null,
  revokedBy: null,
}

// What `busy` holds while writes are under way: a list of keys, one per connect, disconnect or sign-in.
export const busyKey = {
  disconnect: (planId: number) => `disconnect:${planId}`,
  signIn: 'sign-in',
  isSigningIn: (busy: string[]) => busy.includes('sign-in'),
  isDisconnecting: (busy: string[]) => busy.some(k => k.startsWith('disconnect:')),
}

// every link is built on the origin the plan read answered (`dashboard_url`), carried on the
// connected plan: there is no origin constant, so a link always opens the dashboard the data came from.
export function planUrl(plan: ConnectedPlan): string {
  return `${plan.dashboardUrl}/plans/${plan.id}`
}

// the plan page's Needs You tab, which the band's Needs You badge opens. `needs-you` is the id of the dashboard's Needs You bucket, which the plan page reads from `?tab=`.
export const NEEDS_YOU_BUCKET_ID = 'needs-you'
export function needsYouUrl(plan: ConnectedPlan): string {
  return `${planUrl(plan)}?tab=${NEEDS_YOU_BUCKET_ID}`
}

// The one builder of a card's page: problem links are built on it.
export function cardUrl(plan: ConnectedPlan, cardId: string): string {
  return `${planUrl(plan)}/cards/${cardId}`
}

// a card on a board of its own, outside the connected plan: the dashboard's plan-free card route (`board/:id`). Plan cards go through cardUrl.
// The band also links the stand-alone card a session holds, which has no plan: only the dashboard origin is needed.
export function boardCardUrl(plan: { dashboardUrl: string }, cardId: string): string {
  return `${plan.dashboardUrl}/board/${cardId}`
}

// the band's Disconnect control: a broken-chain glyph, since a Button holds only text, never an Svg icon (operator, 2026-10-23)
export const DISCONNECT_GLYPH = '⛓️‍💥'
export const DISCONNECTING_LABEL = 'Disconnecting…'
// the footer when no team agent is known for the session: the dashboard holds none, or the load failed (the band then says Disconnected too).
export const NO_AGENT_LABEL = '50 Arms disconnected'

// The donut's size in px (Svg takes CSS pixels): the band line's.
export const DONUT_BAND_PX = 16

// what the events warning says for a connected session the server reports no event listener for
// (`sessionListenerAttached` null): the plugin knows only that no status came, so it says that; never green, never silent.
export const NO_EVENT_STATUS = 'the dashboard sent no event status for this session'

// a session with no dashboard key. The danx-dashboard MCP answers every tool but `plan_connect` with an error
// result whose text holds this sentence, both when it never had a key (SIGN_IN_HALT) and when its key lapsed (KEY_LAPSED_HALT
// ends with it): the dashboard's answer when the session has no usable key. A key a PERSON revoked is not this: it is the stop halt below.
// The text is for the agent: the person only ever reads the words below.
export const SIGNED_OUT_MARK = 'Not signed in to the danxbot dashboard'
export const SIGNED_OUT_LABEL = `${BRAND}: signed out`
export const SIGN_IN_LABEL = 'Sign in'
export const SIGNING_IN_LABEL = 'Signing in…'
export const SIGNED_IN_TOAST = 'Signed in'
// a sign-in request has no round limit (it stays open while its session lives); these end it
export const SIGN_IN_EXPIRED_TOAST = 'Sign in expired. A new request is open.'
// the shortest a watch's round may take: the MCP's own ~45 s wait normally paces it; an answer that returns at once must not spin it
export const SIGN_IN_MIN_ROUND_MS = 5_000
export const SIGN_IN_DENIED_TOAST = 'Sign in was denied.'
export const signInFailedToast = (message: string) => `Sign in failed: ${message.slice(0, FAILURE_TOAST_MAX)}`

// in auto permission mode the engine's classifier refuses the plugin's own calls to its own dashboard server until the allow rule
// is added. The refusal is neither signed out nor a failed load: ONE state (the `blocked` phase, and every toast of a refused call) says so, in
// the person's words: the cause, then the fix. It is no sticky state: the next load that succeeds replaces it, and the relay retries on its own.
export const BLOCKED_LABEL = `${BRAND}: blocked by auto mode`
export const BLOCKED_LINE = "Auto mode is blocking Danxbot's calls. Run /danxbot:start to allow them; this clears by itself, or restart the session if it does not."

// a person revoked the session's key. The MCP (0.1.225) answers EVERY tool, plan_connect included, with one stop halt and
// makes no access request, only a revoked-access halt that begins
// `STOP ALL WORK NOW. <revokedBy> revoked your access to the danxbot dashboard at <revokedAt>.` followed by a blank line. The
// text is for the agent (it tells it to commit and stop); the person reads the words below, and there is no Sign in: a
// revoked agent must stop.
export const KEY_REVOKED_HALT = /^STOP ALL WORK NOW\. (.+) revoked your access to the danxbot dashboard at \S+\.\n/
export const keyRevokedLabel = (by: string) => `${BRAND}: access revoked by ${by}`
export const KEY_REVOKED_FOOTER = `${BRAND}: access revoked`
