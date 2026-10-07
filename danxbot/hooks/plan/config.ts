import type { ConnectedPlan, LiveSubagents, PlanView, SubagentState } from '../../types'

export const PANE = 'danx-plan'
// DX-4419: the name every footer and pane label, and the band's not-connected, loading and disconnected states, carry,
// so the operator can tell the text is danxbot's.
export const BRAND = 'Danxbot'
export const PLAN_TITLE = `${BRAND} Plan`
// DX-4420: the problem icon on the band's count button (a Button label is text only).
export const PROBLEM_GLYPH = '⚠'
export const COMMAND = 'danx-plan'
// DX-4578: the one dashboard MCP server, the one this plugin ships (plugin.json `mcpServers`): Claude Code names a plugin's server
// `plugin:<plugin>:<server>` (verified live with `claude mcp list`) and its tools `mcp__<server with : as _>__<tool>`. No repo
// declares a `danx-dashboard` server of its own any more, so there is no second name to try.
export const SERVER = 'plugin:danxbot:danx-dashboard'
export const toolName = (tool: string) => `mcp__${SERVER.replace(/:/g, '_')}__${tool}`
// DX-4339: how often the usage pacing panel is read (it has no event to ride). The plan view is never polled (DX-4233).
export const PACING_POLL_MS = 60_000
export const MIN_GAP_MS = 10_000
// DX-4530: while a permission request is open its claim is polled this often (the pacing panel's poll otherwise), so the model hears the
// decision within seconds. The server's per-key claim limit (danxbot permission-request-routes.ts: twice one 3 s poll, about
// 0.67 claims a second) fits the MCP's own 3 s poll plus this one for ONE open request; with more open at once the MCP's poll
// alone passes it, and this poll's 429 only keeps the request for the next tick.
export const PERMISSION_POLL_MS = 10_000
// DX-4530: how many decided permission requests the told-once guard ($.store) remembers; ids are unique, so the oldest go first.
export const PERMISSION_TOLD_MAX = 100

// The dashboard's six card statuses, in the order a view's breakdown is read.
export const STATUS_KEYS = ['In Progress', 'ToDo', 'Backlog', 'Review', 'Done', 'Cancelled'] as const

// How much one load reads. Past a cap the view says so (cardsTotal vs cardsRead)
// rather than presenting a lower bound as the whole.
export const MAX_PLANS = 30
export const MAX_CARDS = 15
// DX-4499: the live sessions of the plan whose sub-agents one load reads (one call each). The list route answers no total, so
// a full page is the signal that there may be more (`sessionsCapped`).
export const MAX_SESSIONS = 20
// DX-4448: an issue prefix as a board names it (`DX`, `SSL`): capital letters, at most this many. Anything else in a boards
// answer is an error (card-links.ts still escapes them, so a prefix can never change the matcher).
export const PREFIX_MAX = 10
export const PREFIX_PATTERN = new RegExp(`^[A-Z]{1,${PREFIX_MAX}}$`)

// DX-4499: a sub-agent starting or stopping asks for a refresh at once, and for one more this long after: the plugin's own
// SubagentStart / SubagentStop command hooks report the change to the dashboard at the same moment, so the first read can come
// before the report does. One wait after one event, never a repeating one.
export const SUBAGENT_SETTLE_MS = 5_000
// DX-4499: how often the pane's clock advances while it shows a sub-agent: the runtime's seconds, drawn only, no call.
export const TICK_MS = 1_000
// DX-4336: where the session reports its rate-limit windows, and how often it does so before danxbot has said (every answer carries
// `report_every_ms`, danxbot's own USAGE_REPORT_TICK_MS, which the plugin then follows). The tick matters even when nothing moved: an idle
// session's figure freezes at its last response and `session.measure` skips a moved reset time at an unchanged percent (CAV-6).
export const USAGE_PATH = '/api/plan-sessions/me/usage'
export const USAGE_TICK_MS = 60_000
// ... and the shortest cadence the plugin accepts from danxbot: a smaller one is a malformed answer, not a request to report in a loop.
export const MIN_USAGE_TICK_MS = 5_000

// DX-4233: EVERY plan load (the first and each refresh) answers within this or is shown as an error.
export const LOAD_DEADLINE_MS = 30_000
// ... and a load past its deadline is not left running beside the next: its refresh keeps the lock for up to this long more, applies the
// answer if it comes in that time, and gives the call up after it.
export const LOAD_ORPHAN_WAIT_MS = 30_000
// A refresh lock held longer than this is a dead step's, not a running one's: a load holds it for its deadline and the orphan wait at most, so
// what is left to hang is a step after it (the live sync, a permission claim). The tail is what those steps may take after the orphan wait, so
// a holder that is just finishing is not taken over the moment it lands. A refresh asked past it, forced or not, takes the lock over.
export const LOCK_TAIL_MS = 10_000
export const LOCK_STALE_MS = LOAD_DEADLINE_MS + LOAD_ORPHAN_WAIT_MS + LOCK_TAIL_MS

// At session start the MCP server may not be connected yet: a first load that failed on exactly that is retried after
// each of these waits (clock-driven) before the view settles on the error. (The relay's own start retries: RELAY_START_RETRY_MS.)
export const NOT_CONNECTED_RETRY_MS = [2_000, 5_000, 15_000]
// DX-4234: how often a session start looks for the plugin's own server in the session's tool list, until the start's deadline (CONTEXT_DEADLINE_MS)
export const SERVER_POLL_MS = 500

// Truncation lengths, each for one place.
// DX-4420: the band's plan name is cut to the columns the band has left after its controls (`bandLabelCols` in words.ts), never to a fixed
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
// DX-4499: the sub-agent card's long lines, each cut with an ellipsis so one line never wraps the card.
export const SUBAGENT_LABEL_MAX = 60
export const SUBAGENT_ACTIVITY_MAX = 90
// DX-4508: a sub-agent's title is its description, else its agent type, never its id (`agent-a7526d...`); with neither, this.
export const SUBAGENT_UNTITLED = 'Sub-agent'
// DX-4499: the section's one line when the dashboard has no sub-agents route yet (an older dashboard than DX-4498's).
export const SUBAGENTS_UNAVAILABLE_LINE = 'This dashboard does not report sub-agents yet.'

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
// DX-4656: the pacing band's `hold` (over pace, nothing new starts until the reset): no named terminal colour is orange, so a hex that the terminal rounds to its nearest.
export const ORANGE = '#ff8700'

// DX-4499 / DX-4508: a sub-agent's status dot, one colour per state: green running, cyan done, red failed, yellow stopped (a
// person or a lapsed session ended it). The dot is the only coloured mark on the card: its border is drawn in the card's own fill.
export const SUBAGENT_STATE_COLOR: Record<SubagentState, string> = {
  running: SUCCESS,
  done: ACCENT,
  failed: DANGER,
  stopped: WARNING,
}
// DX-4508: the card's raised surface, a theme key so it reads on a light and a dark theme alike. Claude Code's own background
// task rows are drawn on `userMessageBackground` (its hover `userMessageBackgroundHover`), the slightly lighter grey of a user
// prompt (dark theme rgb(55,55,55)); the theme's other fills are the docked sidebar's own colour (`composerSidebarBackground`, the
// pane itself, so no raise), the selection blue, and the bash/memory message tints. Checked in the 2.1.286 build's themes.
// DX-4508: rounded corners with no visible line: a Box rounds only by drawing a `round` border, so the card draws one in this same
// colour (decision on DX-4508, 2026-10-04).
export const SUBAGENT_CARD_BACKGROUND = 'userMessageBackground'

// DX-4508: the host child that streams this session's sub-agent numbers: `node <plugin root>/<this> <main transcript>`. The script finds
// the installed danx-dashboard-mcp and runs its `subagents-live` (a hooks module is never told the plugin's data directory).
export const LIVE_READER_SCRIPT = 'scripts/subagents-live.mjs'
// DX-4508: how long an ended sub-agent stays listed after it finished: danxbot's SUBAGENT_ENDED_VISIBLE_MS
// (src/issues/db/plan-session-subagents.ts), mirrored for a row only the live child has reported so far.
export const SUBAGENT_ENDED_VISIBLE_MS = 600_000
// DX-4508: the one line the section shows when the live numbers cannot be read; the dashboard's numbers stand.
export const liveUnavailableLine = (reason: string) => `Live numbers unavailable: ${reason}`
export const LIVE_REASON_MAX = 160
// DX-4508: no live child has reported yet.
export const NO_LIVE: LiveSubagents = { sessionId: null, snapshots: {}, statuses: {}, warning: null, failed: false }

export const EMPTY: PlanView = {
  phase: 'loading',
  error: null,
  serverNotConnected: false,
  dashboardUrl: null,
  connected: null,
  plans: [],
  problems: [],
  cardErrors: [],
  cardsTotal: 0,
  cardsRead: 0,
  plansUnread: 0,
  statusBreakdown: null,
  inProgress: [],
  inProgressTotal: 0,
  subagents: { rows: [], errors: [], sessionsCapped: false, unavailable: false },
  // DX-4448: nothing to link until a load reads the boards and the plan's cards
  links: { state: 'ready', prefixes: [], planCardIds: [] },
  listener: null,
  refreshedAt: null,
  resumePlan: null,
  revokedBy: null,
}

// What `busy` holds while writes are under way: a list of keys, one per connect, disconnect or sign-in.
export const busyKey = {
  connect: (planId: number) => `connect:${planId}`,
  disconnect: (planId: number) => `disconnect:${planId}`,
  signIn: 'sign-in',
  isSigningIn: (busy: string[]) => busy.includes('sign-in'),
  isDisconnecting: (busy: string[]) => busy.some(k => k.startsWith('disconnect:')),
  isConnecting: (busy: string[]) => busy.some(k => k.startsWith('connect:')),
}

// DX-4317: every link is built on the origin the plan list answered (`dashboard_url`), carried on the
// connected plan: there is no origin constant, so a link always opens the dashboard the data came from.
export function planUrl(plan: ConnectedPlan): string {
  return `${plan.dashboardUrl}/plans/${plan.id}`
}

// DX-4521: the dashboard's plans list, where the band's links go while no plan is connected.
export function plansUrl(dashboardUrl: string): string {
  return `${dashboardUrl}/plans`
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

// DX-4609: a problem on its card in the browser, where every interaction with it happens.
export function problemUrl(plan: ConnectedPlan, cardId: string, problemId: number): string {
  return `${cardUrl(plan, cardId)}/problems/PBLM-${problemId}`
}

// DX-4448: a card on a board of its own, outside the connected plan: the plan-free card route (danxbot
// frontend/src/app/routes.tsx `board/:id`). Plan cards go through cardUrl.
export function boardCardUrl(plan: ConnectedPlan, cardId: string): string {
  return `${plan.dashboardUrl}/board/${cardId}`
}

// The donut's size in px (Svg takes CSS pixels): the band line's, and the pane header's.
export const DONUT_BAND_PX = 16
export const DONUT_PANE_PX = 44

// DX-4374: what the pane's event line says for a connected session the server reports no event listener for
// (`sessionListenerAttached` null): the plugin knows only that no status came, so it says that; never green, never silent.
export const NO_EVENT_STATUS = 'the dashboard sent no event status for this session'

// DX-4423: a session with no dashboard key. The danx-dashboard MCP answers every tool but `plan_connect` with an error
// result whose text holds this sentence, both when it never had a key (SIGN_IN_HALT) and when its key lapsed (KEY_LAPSED_HALT
// ends with it): packages/danx-dashboard-mcp session-access.ts. A key a PERSON revoked is not this: it is the stop halt below.
// The text is for the agent: the person only ever reads the words below.
export const SIGNED_OUT_MARK = 'Not signed in to the danxbot dashboard'
export const SIGNED_OUT_LABEL = `${BRAND}: signed out`
export const SIGNED_OUT_LINE = "This session's access ended. Sign in to reconnect."
export const SIGN_IN_LABEL = 'Sign in'
export const SIGNING_IN_LABEL = 'Signing in…'
export const SIGNED_IN_TOAST = 'Signed in'
// DX-4548: a sign-in request has no round limit (it stays open while its session lives); these end it
export const SIGN_IN_EXPIRED_TOAST = 'Sign in expired. A new request is open.'
// the shortest a watch's round may take: the MCP's own ~45 s wait normally paces it; an answer that returns at once must not spin it
export const SIGN_IN_MIN_ROUND_MS = 5_000
export const SIGN_IN_DENIED_TOAST = 'Sign in was denied.'
export const signInFailedToast = (message: string) => `Sign in failed: ${message.slice(0, CONNECT_ERROR_MAX)}`

// DX-4418: a person revoked the session's key. The MCP (0.1.225) answers EVERY tool, plan_connect included, with one stop halt and
// makes no access request: `keyRevokedHalt` in packages/danx-dashboard-mcp key-revoked-halt.ts, which begins
// `STOP ALL WORK NOW. <revokedBy> revoked your access to the danxbot dashboard at <revokedAt>.` followed by a blank line. The
// text is for the agent (it tells it to commit and stop); the person reads the words below, and there is no Sign in: a
// revoked agent must stop.
export const KEY_REVOKED_HALT = /^STOP ALL WORK NOW\. (.+) revoked your access to the danxbot dashboard at \S+\.\n/
export const keyRevokedLabel = (by: string) => `${BRAND}: access revoked by ${by}`
export const KEY_REVOKED_FOOTER = `${BRAND}: access revoked`
export const KEY_REVOKED_LINE = "A person revoked this session's access, so the session must stop. Nothing here can sign it in again."
