// The plan this session is bound to, read from the session in the `GET /api/plans` answer (session.plan_id
// and session.plan_name); that read asks for one plan row only, so the label never depends on a list.
export type ConnectedPlan = {
  id: number
  ref: string
  name: string
  // The dashboard's public origin (`dashboard_url` on the GET /api/plans answer, e.g. `https://host` or
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

// A card in the plan's in-progress bucket (not waiting on the operator): the plugin lists its id (DX-4415); the title
// is read by the compaction briefing (compactionBriefing in register.tsx).
export type InProgressRow = {
  id: string
  title: string
}

// DX-4374: the server's `sessionListenerAttached {attached, state, nextStep}`, less `attached`. Only the exact
// state `healthy` is a working listener; `nextStep` is the server's own wording (null when it has none).
export type ListenerStatus = { state: string; nextStep: string | null }

// `signed-out` (DX-4423): the server is there but the session holds no dashboard key (lapsed, or never approved):
// the band says so and offers Sign in, never the server's agent-facing text.
// `key-revoked` (DX-4418): a person revoked the session's key (`revokedBy`): the band says so and offers NO
// Sign in, because a revoked agent must stop.
// DX-4448: `prefixes` are the issue prefixes (`DX`, `SG`) of the dashboard's boards (GET /api/boards); `planCardIds` are the ids of
// EVERY card on the connected plan, any status (GET /api/plans/:id/cards, unscoped by board, closed cards included). Empty when not connected.
export type CardLinks = { state: 'ready'; prefixes: string[]; planCardIds: string[] } | { state: 'error'; message: string }

export type PlanView = {
  // `loading` is both the first load (nothing known yet) and a connect answered with its numbers still pending (DX-4635: `connected` and `refreshedAt` set).
  phase: 'loading' | 'ready' | 'error' | 'signed-out' | 'key-revoked'
  error: string | null
  // DX-4578: the load failed because the plugin's own MCP server is not connected (yet), the one failure the session-start retry waits out
  serverNotConnected: boolean
  // DX-4521: the dashboard origin the band's links are built on: the one the plan list answered, else (a failed or signed-out load) the
  // last one this machine saw answered; null only while none has ever been seen.
  dashboardUrl: string | null
  connected: ConnectedPlan | null
  // Card counts by status of the connected plan; null when not connected.
  statusBreakdown: StatusBreakdown | null
  // The in-progress bucket's rows (a card in progress with an open problem sits in needs-you, not here).
  inProgress: InProgressRow[]
  // DX-5232: the open problems on the connected plan's cards (the sum of each card's
  // `openProblemCount` on the every-card read); a count, never the problems themselves.
  // null when the every-card read could not give a count (the band then shows none); `openProblemsError` says why.
  openProblems: number | null
  openProblemsError: string | null
  // DX-4448: what card ids in an assistant reply are linked with, read at refresh (never at draw time). It is its OWN state: a
  // failed read of it leaves the plan view `ready`, shows one toast, and replies are then drawn as written.
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

// DX-4339: the usage pacing state (see hooks/plan/pacing-model.ts).
export type PacingMode = 'fast_then_hold' | 'spread_evenly'
export type LimitSettings = { enabled: boolean; targetPercent: number; mode: PacingMode; criticalPercent: number }
// DX-4595 (PLAN-29 G-5): spend is the third limit. Its settings carry the money budget and the period it is spent over; its figure is never computed here
// (the plugin cannot price tokens) but read from the line answer (`SpendFigure`).
export type SpendSettings = LimitSettings & { budgetUsd: number | null; period: { kind: 'hours' | 'days'; count: number } }
export type TeamSettings = { five_hour: LimitSettings; weekly: LimitSettings; spend: SpendSettings }
export type PacingLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type PacingLevel = 'on_pace' | 'over_pace' | 'critical'
// The account's verdict for this session (DX-4340's cache): `budget` null = no cap, 0 = start nothing new, n = most agents at once.
// DX-4595: the account's spend limit as the server priced it (GET /api/pacing/line `spend`): percent of the account's budget spent in the current period, the period end as `resetsAt`.
export type SpendFigure = { usedPercent: number; level: PacingLevel; resetsAt: string; spentUsd: number; budgetUsd: number }
// DX-4656 (DX-4655): one limit's readout as the server judged it (GET /api/pacing/line `limits[]`), never recomputed here. `headroomMinutes`: positive = the window resets that long before the target would be reached (spare), negative = the target is reached that long before the reset (short). `resetsInMinutes`: whole minutes to the reset.
export type PacingLimitKey = 'five_hour' | 'weekly' | 'spend'
export type PacingState = 'spare' | 'short' | 'hold' | 'stop'
export type LimitReadout = {
  limit: PacingLimitKey
  level: PacingLevel
  state: PacingState
  headroomMinutes: number
  resetsInMinutes: number
  usedPercent: number
  targetPercent: number
  criticalPercent: number
  resetsAt: string
}
export type PacingReadout = { limits: LimitReadout[]; worst: PacingLimitKey }
export type PacingVerdict = { level: PacingLevel; budget: number | null; resetsAt: string | null; runningAgents: number }
// How the last read of the team's settings went. `pending`: none yet (session start), quiet. `silent`: no danx-dashboard MCP, no danxbot or no key
// (DX-3421 / DX-4340: said nowhere but the band's `local`). `error`: danxbot answered and the answer was unusable (the band says `local`).
export type SettingsRead = { state: 'pending' | 'ok' | 'silent' } | { state: 'error'; message: string }
export type PacingSnapshot = {
  // the last settings read; kept through a failed read so the pacing can still show them, marked local
  settings: TeamSettings | null
  settingsRead: SettingsRead
  // the account verdict as of the last refresh (null: none, or not trusted while the settings read is failing)
  verdict: PacingVerdict | null
  // DX-4595: the account's spend figure from the same line answer (null: none, or not trusted while the settings read is failing)
  spend: SpendFigure | null
  // DX-4656: each enabled limit's state and headroom and the worst one, from the same line answer (null: none, or not trusted while the settings read is failing)
  readout: PacingReadout | null
  // the session's own windows, as the harness last reported them (empty when its usage could not be read)
  limits: PacingLimit[]
}

// DX-4435: a `request_permission` request the band counts until it is decided. DX-4530: no expiry clock (the claim decides it).
export type PermissionRequest = { url: string; code: string; publicId: string; permissions: string[] }

// DX-4721: the main loop's turn as the delivery of an urgent event needs it: whether a turn is running now, and the texts of the urgent notes
// appended into it that no main-loop tool result has carried yet (hooks/relay/delivery.ts).
export type TurnState = { isRunning: boolean; pending: string[] }

// DX-4233: the event relay's state, as the band's events warning shows it. `streaming`: waiting on the server for events (or just
// delivered some); `retrying`: the last wait or delivery failed and the relay tries again on its own (`detail` is the cause);
// `stopped`: the server said the relay cannot go on (`detail` is its fix); `off`: no relay runs (not connected, signed out).
export type RelayState = { phase: 'off' | 'streaming' | 'retrying' | 'stopped'; planId: number | null; detail: string | null }

// DX-4234: the last time stamp handed to the model: when (epoch ms) and which local day (YYYYMMDD) it was; null before the first.
export type StampState = { at: number; day: string } | null

// DX-4234: a session start the model has not yet been told about: SessionStart records it (the engine has not bound the session yet, so it
// cannot call the MCP), and the next prompt.submit or main-loop tool.call result consumes it.
export type PendingStart = { sessionId: string; source: string; transcriptPath: string | null; predecessorId: string | null } | null

// DX-4235: what the reports remember between events: what this session reported opening and still owes a close. `agents`: by activity id
// (`agent-<id>`), each running sub-agent whose start was posted, with the time (epoch ms) of its last post (the start or a liveness
// re-post); its finish removes it. `shells`: the background task ids of the shells whose start was posted and that no Stop has closed yet.
// `planId`: the plan the session was on when the
// latest of them opened, null when nothing is open: a move to another plan closes what was opened under this one first.
export type ReportState = { agents: Record<string, number>; shells: string[]; planId: number | null }

declare module 'claude-code' {
  interface PluginState {
    danxbot: {
      view: PlanView
      gate: RefreshGate
      // The band is hidden for the session (the footer button or /danx-plan brings it back). Its own atom: refresh
      // replaces `view` whole, so a flag inside it would be reset by every refresh.
      dismissed: boolean
      // keys of the writes under way (config busyKey): one per connect, disconnect or sign-in
      busy: string[]
      // The session's title as the app last reported it, passed to `plan_connect`.
      title: string | null
      // DX-4630: the sign-in request waiting for the person (its approval link and confirm code), drawn by the band; null when none.
      signInRequest: { url: string; code: string } | null
      // DX-4435: the model's undecided permission requests, oldest first.
      permissionRequests: PermissionRequest[]
      // DX-4508: the MAIN session's transcript path, as the classic events last carried it (`transcript_path`): the plan event wait carries it.
      transcript: string | null
      // DX-4336: the failure text of the last usage report to danxbot, null while reports are accepted (a repeat is toasted once).
      usageError: string | null
      // DX-4336: when the last API response arrived (epoch ms): the age of the usage figure. null until one has.
      measuredAt: number | null
      // DX-4336: the sub-agents running now, by id and start time (the report's runningAgents is this plus the main thread).
      liveAgents: { id: string; since: number }[]
      // DX-4339: what the usage pacing draws: the session's own windows, the team's pacing settings and the account verdict as last read.
      pacingState: PacingSnapshot
      // DX-4233: the event relay's state (see RelayState): the band's events warning says it when it is not streaming.
      relay: RelayState
      // DX-5232: the events warning last toasted (null: none), so its reason is told once per transition
      eventsWarned: string | null
      // DX-4721: the main loop's turn as the delivery of an urgent event needs it (see TurnState).
      turn: TurnState
      // DX-4234: the last time stamp handed to the model (see StampState): the next one counts its +delta and its date from it.
      lastStamp: StampState
      // DX-4234: the session start waiting for the next prompt or main-loop tool result (see PendingStart).
      pendingStart: PendingStart
      // DX-4234: the id of the session a /clear just ended (session.end), until the start of the session that replaced it takes it.
      endedSession: string | null
      // DX-3900 / DX-4806: the desktop app hosts this session (the keepalive's gate): raised at a session start that lists the desktop or whose CLAUDE_CODE_ENTRYPOINT is claude-desktop, and at any desktop
      // attach, never cleared, and kept by a reload of the hooks module, whose own variables start over.
      desktopHosted: boolean
      // DX-4806: when the keepalive's current idle period began (epoch ms); null while no plan is followed. A reload of the hooks module resumes from it.
      idleSince: number | null
      // DX-4997: the person was told, once, that this dashboard has no agent-pause route (a plugin newer than the dashboard).
      olderDashboardTold: boolean
      // DX-5093: the person was told, once, that the desktop's Browser pane is not reachable from the plugin (the plan tab is not kept open).
      browserMissingTold: boolean
      // DX-4993 / DX-5217: the early-proposal percent (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) the plugin armed on the session (the board's floor as a percent of the model's window); null while it holds none. Kept by a reload of the hooks module, like the process's environment it lives in.
      compactionArmed: number | null
      // DX-4235: the reports' memory (see ReportState).
      reports: ReportState
    }
  }
}
