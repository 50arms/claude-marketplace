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
// `blocked` (DX-4982): auto permission mode's classifier refused the plugin's own dashboard call: the band says so and names the
// fix. `connected` is then the plan the model's own successful plan_connect named, when it did one; nothing else of the plan is known.
// DX-4448: `prefixes` are the issue prefixes (`DX`, `SG`) of the dashboard's boards (GET /api/boards); `planCardIds` are the ids of
// EVERY card on the connected plan, any status (GET /api/plans/:id/cards, unscoped by board, closed cards included). Empty when not connected.
export type CardLinks = { state: 'ready'; prefixes: string[]; planCardIds: string[] } | { state: 'error'; message: string }

export type PlanView = {
  // `loading` is both the first load (nothing known yet) and a connect answered with its numbers still pending (DX-4635: `connected` and `refreshedAt` set).
  phase: 'loading' | 'ready' | 'error' | 'signed-out' | 'key-revoked' | 'blocked'
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

// DX-4339: the pacing line's wire shapes (hooks/plan/pacing-line.ts).
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
// DX-5344: who is compacting. `main` is the epoch ms of the main agent's compaction proposal (null: none); `agents` has one entry per sub-agent (bare id), `at` its proposal's time, or its
// compaction's finish once `done`, and `done` is true once its compaction finished and its own briefing waits for its next tool result.
export type CompactingState = { main: number | null; agents: Record<string, { at: number; done: boolean }> }

export type PendingStart = { sessionId: string; source: string; transcriptPath: string | null; predecessorId: string | null } | null

// DX-4235: what the reports remember between events: what this session reported opening and still owes a close. `agents`: by activity id
// (`agent-<id>`), each running sub-agent whose start was posted, with the time (epoch ms) of its last post (the start or a liveness
// re-post); its finish removes it. `shells`: the background task ids of the shells whose start was posted and that no Stop has closed yet.
// `planId`: the plan the session was on when the
// latest of them opened, null when nothing is open: a move to another plan closes what was opened under this one first.
export type ReportState = { agents: Record<string, number>; shells: string[]; planId: number | null }

// DX-5398: a plan event the relay has taken from the server and not yet delivered to the session, kept in $.state so a reload of the hook module (which
// empties the module's own outbox) finds it again. The server drops every event at or below the cursor a poll presents, so this copy is the only one.
export type PendingEvent = { planId: number | null; cursor: string; text: string; urgent: boolean }

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
      // DX-4982: the plan the model's own successful plan_connect named, for the blocked view
      modelPlan: { id: number; name: string } | null
      // DX-4435: the model's undecided permission requests, oldest first.
      permissionRequests: PermissionRequest[]
      // DX-4508: the MAIN session's transcript path, as the classic events last carried it (`transcript_path`): the plan event wait carries it.
      transcript: string | null
      // DX-4336: the failure text of the last usage report to danxbot, null while reports are accepted (a repeat is toasted once).
      usageError: string | null
      // DX-4336: when the last API response arrived (epoch ms): the age of the usage figure. null until one has.
      measuredAt: number | null
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
      // DX-5231: the leftover compaction-trigger variables of an older plugin version were cleared in this process (once; a later writer's value is never touched).
      leftoverArmingCleared: boolean
      // DX-5222: the percent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE holds because the plugin armed it for the sub-agents (null: it armed none); the variable lives in the process, so a reload keeps both.
      armedPercent: number | null
      // DX-5222: this host runs `session.compact` (raised by its first event). One of two inputs to `hostRunsSessionCompact` (the other: the engine release, `engineCompact`): when it holds, the classic PreCompact gate leaves automatic proposals to `session.compact`, and the sub-agents' percent is armed.
      sessionCompactSeen: boolean
      // DX-5365: what the engine's release says about `session.compact`, read once per process: 'unread' until first asked, then 'runs' (a release from 2.1.299), 'older', or 'unreadable' (the call threw or named no release).
      engineCompact: 'unread' | 'runs' | 'older' | 'unreadable'
      // DX-5222: the sub-agent requests claimed for sending (`<session>:<agent>` to the request's `at`), one compare-and-set before `$.session.send`; a failed send gives the claim back.
      claimedAsks: Record<string, string>
      // DX-5231: the release the plugin claimed to start a compaction with (one compare-and-set, so a ready starts once)
      claimedRelease: string | null
      // DX-5344: who is compacting, one entry per agent (see CompactingState).
      compacting: CompactingState
      // DX-4235: the reports' memory (see ReportState).
      reports: ReportState
      // DX-5398: the relay's undelivered events, in the order the server sent them (see PendingEvent).
      relayOutbox: PendingEvent[]
    }
  }
}
