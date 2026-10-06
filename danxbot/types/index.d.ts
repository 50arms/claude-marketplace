export type PlanRow = {
  id: number
  ref: string
  name: string
  status: string
  needsYou: number
}

export type ProblemRow = {
  id: number
  cardId: string
  cardTitle: string
  type: 'question' | 'action'
  statement: string
}

// The plan this session is bound to, read from the same response as the plan list (session.plan_id
// and session.plan_name), so a plan beyond the list's cap still labels correctly. `status` is the
// list row's, null when the plan is not in the capped list.
export type ConnectedPlan = {
  id: number
  ref: string
  name: string
  // read with the plan itself (GET /api/plans/:id), never from the capped list
  status: string
  // The dashboard's public origin (`dashboard_url` on GET /api/plans, e.g. `https://host` or
  // `http://localhost:5555`), with no path: every link to the plan, a card or a problem starts with it.
  dashboardUrl: string
}

// The dashboard's card counts by status for one plan (`status_breakdown`); all six keys are required.
export type StatusBreakdown = {
  'In Progress': number
  ToDo: number
  Backlog: number
  Review: number
  Done: number
  Cancelled: number
}

// A card in the plan's in-progress bucket (not waiting on the operator), as the pane lists it.
export type InProgressRow = {
  id: string
  title: string
  // the readable agent name from the issue resource; null when nobody holds the card
  agent: string | null
  // when the card last changed: NOT when it went In Progress (no field says that)
  updatedAt: string
}

// DX-4374: the server's `sessionListenerAttached {attached, state, nextStep}`, less `attached`. Only the exact
// state `healthy` is a working listener; `nextStep` is the server's own wording (null when it has none).
export type ListenerStatus = { state: string; nextStep: string | null }

// `signed-out` (DX-4423): the server is there but the session holds no dashboard key (lapsed, or never approved):
// the band and pane say so and offer Sign in, never the server's agent-facing text.
// `key-revoked` (DX-4418): a person revoked the session's key (`revokedBy`): the band and pane say so and offer NO
// Sign in, because a revoked agent must stop.
// DX-4448: `prefixes` are the issue prefixes (`DX`, `SG`) of the dashboard's boards (GET /api/boards); `planCardIds` are the ids of
// EVERY card on the connected plan, any status (GET /api/plans/:id/cards, unscoped by board, closed cards included). Empty when not connected.
export type CardLinks = { state: 'ready'; prefixes: string[]; planCardIds: string[] } | { state: 'error'; message: string }

// DX-4499: one sub-agent of a connected session, as GET /api/plan-sessions/:sessionId/subagents (DX-4498) answers it, in the
// shape the pane draws a card from. `state` is the server's (running, or how it ended); the pane counts a running one's
// runtime up from `startedAt` on its own clock and drops an ended one at `visibleUntil` (epoch ms, both).
export type SubagentState = 'running' | 'done' | 'failed' | 'stopped'
// DX-4508: the card a sub-agent works on. `title` is null when only the live child named the card and the pane has loaded
// no card of that id: the id link is drawn alone.
export type SubagentCard = {
  id: string
  title: string | null
}
export type SubagentRow = {
  // `agent-<agent id>`: the key `parentId` of another row names
  id: string
  sessionId: string
  parentId: string | null
  // the label its spawning call gave it; null when it was given none
  label: string | null
  agentType: string | null
  model: string | null
  effort: string | null
  state: SubagentState
  startedAt: number
  // null while it runs
  finishedAt: number | null
  // null while it runs
  visibleUntil: number | null
  tokensTotal: number
  costUsd: number
  toolCalls: number
  // its latest tool call as the server words it (a tool name and at most a label the agent wrote); null before its first
  activity: string | null
  card: SubagentCard | null
}

// The pane's sub-agents: every row the live sessions of the plan answered, and one person-facing line per read that failed
// (the plan view stays `ready` either way, as with `links` and `cardErrors`). `sessionsCapped`: the plan has as many live
// sessions as one load reads, so there may be more than were read.
export type SubagentsView = {
  rows: SubagentRow[]
  errors: string[]
  sessionsCapped: boolean
  // every session's sub-agents read answered 404: the dashboard has no such route yet (it predates DX-4498). Not an error line per
  // session: the section says so once, quietly.
  unavailable: boolean
}

// DX-4508: one sub-agent as the live child (`danx-dashboard-mcp subagents-live <main transcript>`) prints it, epoch ms.
export type LiveSnapshot = {
  // `agent-<agent id>`, the dashboard row's id
  id: string
  parentId: string | null
  description: string | null
  agentType: string | null
  model: string | null
  effort: string | null
  startedAt: number
  lastActivityAt: number
  finishedAt: number | null
  endStatus: 'completed' | 'failed' | 'stopped' | null
  tokensTotal: number
  costUsd: number
  toolCallCount: number
  currentActivity: string | null
  cardId: string | null
}

// DX-4508: what the live child has reported for THIS session, laid over the dashboard rows when the pane draws.
export type LiveSubagents = {
  // the session the snapshots are of (`$.session.id()` when the child started); null before any child ran
  sessionId: string | null
  snapshots: Record<string, LiveSnapshot>
  // `agent-<id>` -> `$.agent.list()`'s status, read at each start check and each line
  statuses: Record<string, string>
  // why the live numbers are not shown (the child could not start, exited, or printed a line it cannot read); null when they are
  warning: string | null
  // a failure stands until the next sub-agent start (never retried on a refresh)
  failed: boolean
}

export type PlanView = {
  phase: 'loading' | 'ready' | 'error' | 'signed-out' | 'key-revoked'
  error: string | null
  // DX-4578: the load failed because the plugin's own MCP server is not connected (yet), the one failure the session-start retry waits out
  serverNotConnected: boolean
  // DX-4610: ... and this session's plugin server is the old standby one a restart replaces (a subset of serverNotConnected)
  staleServer: boolean
  // DX-4521: the dashboard origin the band's links are built on: the one the plan list answered, else (a failed or signed-out load) the
  // last one this machine saw answered; null only while none has ever been seen.
  dashboardUrl: string | null
  connected: ConnectedPlan | null
  plans: PlanRow[]
  problems: ProblemRow[]
  // DX-4458: one person-facing line per card the load could not read; the other cards still show.
  cardErrors: string[]
  // Needs-you cards the dashboard has, and how many this view read; more than read means the
  // problem list is a lower bound and the pane says so.
  cardsTotal: number
  cardsRead: number
  // Plans the dashboard has that the capped plan list did not return.
  plansUnread: number
  // Card counts by status of the connected plan; null when not connected.
  statusBreakdown: StatusBreakdown | null
  // The in-progress bucket's rows, and how many cards the bucket has (its own count, never the
  // status count's: a card in progress with an open problem sits in needs-you).
  inProgress: InProgressRow[]
  inProgressTotal: number
  // DX-4499: the sub-agents of the plan's live sessions, read in the same refresh as everything above.
  subagents: SubagentsView
  // DX-4448: what card ids in an assistant reply are linked with, read at refresh (never at draw time). It is its OWN state: a
  // failed read of it leaves the plan view `ready` and says so in the pane, and replies are then drawn as written.
  links: CardLinks
  // The event listener as GET /api/plans answers it (`sessionListenerAttached`): the server's health state and
  // its next step; null when the answer carries none (a session on no plan, or no session row).
  listener: ListenerStatus | null
  refreshedAt: string | null
  // DX-4423: the plan this session was on when it was signed out, for Sign in to ask for again; null when not known.
  resumePlan: number | null
  // DX-4418: who revoked the key, on a `key-revoked` view; null on every other.
  revokedBy: string | null
}

// Refresh coalescing: one load in flight, a forced refresh asked meanwhile (`again`) runs once more.
export type RefreshGate = {
  inFlight: boolean
  again: boolean
  at: number | null
}

// DX-4339: the usage pacing panel's state (see hooks/plan/pacing-panel.ts).
export type PacingMode = 'fast_then_hold' | 'spread_evenly'
export type LimitSettings = { enabled: boolean; targetPercent: number; mode: PacingMode; criticalPercent: number }
// DX-4595 (PLAN-29 G-5): spend is the third limit. Its settings carry the money budget and the period it is spent over; its figure is never computed here
// (the plugin cannot price tokens) but read from the line answer (`SpendFigure`).
export type SpendSettings = LimitSettings & { budgetUsd: number | null; period: { kind: 'hours' | 'days'; count: number } }
export type TeamSettings = { five_hour: LimitSettings; weekly: LimitSettings; spend: SpendSettings }
export type PanelLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type PacingLevel = 'on_pace' | 'over_pace' | 'critical'
// The account's verdict for this session (DX-4340's cache): `budget` null = no cap, 0 = start nothing new, n = most agents at once.
// DX-4595: the account's spend limit as the server priced it (GET /api/pacing/line `spend`): percent of the account's budget spent in the current period, the period end as `resetsAt`.
export type SpendFigure = { usedPercent: number; level: PacingLevel; resetsAt: string; spentUsd: number; budgetUsd: number }
export type PacingVerdict = { level: PacingLevel; budget: number | null; resetsAt: string | null; runningAgents: number }
// How the last read of the team's settings went. `pending`: none yet (session start), quiet. `silent`: no danx-dashboard MCP, no danxbot or no key
// (DX-3421 / DX-4340: said nowhere but the band's `local`). `error`: danxbot answered and the answer was unusable; the pane names it.
export type SettingsRead = { state: 'pending' | 'ok' | 'silent' } | { state: 'error'; message: string }
export type PanelState = {
  // the last settings read, and when; kept through a failed read so the panel can still show them, marked local
  settings: TeamSettings | null
  settingsAt: number | null
  settingsRead: SettingsRead
  // the account verdict as of the last refresh (null: none, or not trusted while the settings read is failing)
  verdict: PacingVerdict | null
  // DX-4595: the account's spend figure from the same line answer (null: none, or not trusted while the settings read is failing)
  spend: SpendFigure | null
  // the session's own windows, as the harness last reported them (empty when its usage could not be read)
  limits: PanelLimit[]
}

// DX-4435: a `request_permission` request the band counts until it is decided. DX-4530: no expiry clock (the claim decides it).
export type PermissionRequest = { url: string; code: string; publicId: string; permissions: string[] }

// DX-4233: whether the main loop is in a turn (turn.start .. turn.complete), and the texts of the rows appended since its last model
// request (`turn.step`): the ones a turn that is ending never reads.
export type TurnState = { isInFlight: boolean; unseen: string[] }

// DX-4233: the event relay's state, as the pane's event line shows it. `streaming`: waiting on the server for events (or just
// delivered some); `retrying`: the last wait or delivery failed and the relay tries again on its own (`detail` is the cause);
// `stopped`: the server said the relay cannot go on (`detail` is its fix); `off`: no relay runs (not connected, signed out).
export type RelayState = { phase: 'off' | 'streaming' | 'retrying' | 'stopped'; planId: number | null; detail: string | null }

// DX-4234: the last time stamp handed to the model: when (epoch ms) and which local day (YYYYMMDD) it was; null before the first.
export type StampState = { at: number; day: string } | null

declare module 'claude-code' {
  interface PluginState {
    danxbot: {
      view: PlanView
      gate: RefreshGate
      pick: string
      switching: boolean
      // The band is hidden for the session (the footer button or /danx-plan brings it back). Its own atom: refresh
      // replaces `view` whole, so a flag inside it would be reset by every refresh.
      dismissed: boolean
      // keys of the writes under way (config busyKey): one per connect, disconnect, sign-in or browser open
      busy: string[]
      // The in-app browser tab this plugin owns, so a person's own tabs are never navigated.
      tab: string | null
      // The session's title as the app last reported it, passed to `plan_connect`.
      title: string | null
      // DX-4391: the approval URL last opened, so one request opens its page once.
      approvalOpened: string | null
      // DX-4435: the model's undecided permission requests, oldest first.
      permissionRequests: PermissionRequest[]
      // DX-4499: the clock (epoch ms) a running sub-agent's runtime counts up against: advanced once a second, only while one is
      // shown, and used for nothing but drawing (no call is made on it).
      tick: number
      // DX-4508: the MAIN session's transcript path, as the classic events last carried it (`transcript_path`): the live child reads it.
      transcript: string | null
      // DX-4508: the live child's reports for this session (see LiveSubagents).
      live: LiveSubagents
      // DX-4336: the failure text of the last usage report to danxbot, null while reports are accepted (a repeat is toasted once).
      usageError: string | null
      // DX-4336: when the last API response arrived (epoch ms): the age of the usage figure. null until one has.
      measuredAt: number | null
      // DX-4336: the sub-agents running now, by id and start time (the report's runningAgents is this plus the main thread).
      liveAgents: { id: string; since: number }[]
      // DX-4339: what the usage pacing panel draws: the session's own windows, the team's pacing settings and the account verdict as last read.
      panel: PanelState
      // DX-4233: the event relay's state (see RelayState): the pane's event line says it when it is not streaming.
      relay: RelayState
      // DX-4233: the main loop's turn as the delivery of a relayed event needs it (see TurnState).
      turn: TurnState
      // DX-4234: the last time stamp handed to the model (see StampState): the next one counts its +delta and its date from it.
      lastStamp: StampState
    }
  }
}
