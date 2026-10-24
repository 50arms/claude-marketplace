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

// the team agent the session signs in as (GET /api/plans `session.agent`): its name.
export type SessionAgent = { name: string }

// the stand-alone card the session holds instead of a plan (`session.card_id` / `card_title`).
export type HeldCard = { id: string; title: string }

// The dashboard's card counts by status for one plan (`status_breakdown`); all six keys are required.
export type StatusBreakdown = {
  'In Progress': number
  ToDo: number
  Backlog: number
  Review: number
  Done: number
  Cancelled: number
}

// A card in the plan's in-progress bucket (not waiting on the operator): the plugin lists its id; the title
// is read by the compaction briefing (compactionBriefing in register.tsx).
export type InProgressRow = {
  id: string
  title: string
}

// the server's `sessionListenerAttached {attached, state, nextStep}`, less `attached`. Only the exact
// state `healthy` is a working listener; `nextStep` is the server's own wording (null when it has none).
export type ListenerStatus = { state: string; nextStep: string | null }

// `signed-out`: the server is there but the session holds no dashboard key (lapsed, or never approved):
// the band says so and offers Sign in, never the server's agent-facing text.
// `key-revoked`: a person revoked the session's key (`revokedBy`): the band says so and offers NO
// Sign in, because a revoked agent must stop.
// `blocked`: auto permission mode's classifier refused the plugin's own dashboard call: the band says so and names the
// fix. `connected` is then the plan the model's own successful plan_connect named, when it did one; nothing else of the plan is known.
// `prefixes` are the issue prefixes (`ABC`, `XYZ`) of the dashboard's boards (GET /api/boards); `planCardIds` are the ids of
// EVERY card on the connected plan, any status (`card_ids` on GET /api/plans/:id, unscoped by board, closed cards included). Empty when not connected.
export type CardLinks = { state: 'ready'; prefixes: string[]; planCardIds: string[] } | { state: 'error'; message: string }

export type PlanView = {
  // `loading` is both the first load (nothing known yet) and a connect answered with its numbers still pending (`connected` and `refreshedAt` set).
  phase: 'loading' | 'ready' | 'error' | 'signed-out' | 'key-revoked' | 'blocked'
  error: string | null
  // the load failed because the plugin's own MCP server is not connected (yet), the one failure the session-start retry waits out
  serverNotConnected: boolean
  // the dashboard origin the band's links are built on: the one the plan list answered, else (a failed or signed-out load) the
  // last one this machine saw answered; null only while none has ever been seen.
  dashboardUrl: string | null
  connected: ConnectedPlan | null
  // the session's team agent, and the stand-alone card it holds (a session holds a plan or a card, never both); null when it holds none.
  agent: SessionAgent | null
  card: HeldCard | null
  // the session signed in but holds no team agent, and the MCP's agent gate refuses its dashboard reads until one is held:
  // `agent_needed` (it proposes one), `agent_limit_reached` (the member's or team's cap on sessions signed in as an agent is full: the person ends another or raises the cap), `agent_not_held` (the agent was released; `plan_connect` claims one again); null otherwise. The view is then `ready`.
  agentBlock: 'agent_needed' | 'agent_limit_reached' | 'agent_not_held' | null
  // Card counts by status of the connected plan; null when not connected.
  statusBreakdown: StatusBreakdown | null
  // The in-progress bucket's rows (a card in progress with an open problem sits in needs-you, not here).
  inProgress: InProgressRow[]
  // the plan cards waiting on a person (the plan read's `bucket_counts["needs-you"]`, the number its Needs You tab shows); a count of cards, never of problems.
  // null when the plan read gave no count (the band then shows none); `needsYouError` says why.
  needsYou: number | null
  needsYouError: string | null
  // when the agent's own pause ends (epoch ms), read at each load by the one call that does not end a pause; null when it is not paused,
  // its pause has expired, or the pause read gave no usable answer (the mark is display only). Only the title's pause mark reads it.
  pausedUntil: number | null
  // what card ids in an assistant reply are linked with, read at refresh (never at draw time). It is its OWN state: a
  // failed read of it leaves the plan view `ready`, shows one toast, and replies are then drawn as written.
  links: CardLinks
  // The event listener as GET /api/plans answers it (`sessionListenerAttached`): the server's health state and
  // its next step; null when the answer carries none (a session on no plan, or no session row).
  listener: ListenerStatus | null
  refreshedAt: string | null
  // the plan this session was on when it was signed out, for Sign in to ask for again; null when not known.
  resumePlan: number | null
  // who revoked the key, on a `key-revoked` view; null on every other.
  revokedBy: string | null
}

// Refresh coalescing: one load in flight, a forced refresh asked meanwhile (`again`) runs once more.
export type RefreshGate = {
  inFlight: boolean
  again: boolean
  at: number | null
}

// the pacing line's wire shapes (hooks/plan/pacing-line.ts).
export type PacingLevel = 'on_pace' | 'over_pace' | 'critical'
// The account's verdict for this session (the usage-pacing cache): `budget` null = no cap, 0 = start nothing new, n = most agents at once.
// `reservedAgents` is the slots held for sessions danxbot woke (an offer, for 60 s), taken by no running agent yet; a claim from another session counts them as taken.
export type PacingVerdict = { level: PacingLevel; budget: number | null; resetsAt: string | null; runningAgents: number; reservedAgents: number }

// a `request_permission` request the band counts until it is decided. No expiry clock (the claim decides it).
export type PermissionRequest = { url: string; code: string; publicId: string; permissions: string[] }

// the main loop's turn as the delivery of an urgent event needs it: whether a turn is running now, and the texts of the urgent notes
// appended into it that no main-loop tool result has carried yet (hooks/relay/delivery.ts).
export type TurnState = { isRunning: boolean; pending: string[] }

// the event relay's state, as the events warning (a toast on the change into it) is built from it. `streaming`: waiting on the server for events (or just
// delivered some); `retrying`: the last wait or delivery failed and the relay tries again on its own (`detail` is the cause);
// `stopped`: the server said the relay cannot go on (`detail` is its fix); `off`: no relay runs (not connected, signed out).
export type RelayState = { phase: 'off' | 'streaming' | 'retrying' | 'stopped'; planId: number | null; detail: string | null }

// the last time stamp handed to the model: when (epoch ms) and which local day (YYYYMMDD) it was; null before the first.
export type StampState = { at: number; day: string } | null

// the disk notice last handed to each agent (the main thread is 'main', a sub-agent its id): its text and when (epoch ms). An agent with nothing to be told has no entry.
export type DiskTold = Record<string, { text: string; at: number }>
// the last disk measurement: the notice text it produced ('' when all is well) and when (epoch ms); null before the first or after a session start.
export type DiskMeasured = { text: string; at: number } | null
// where the machine's Windows home is, resolved once per session (a failure is kept too, so a stalled interop call is never retried per tool call).
export type DiskHome = { home: string } | { fault: string } | null

// a session start the model has not yet been told about: SessionStart records it (the engine has not bound the session yet, so it
// cannot call the MCP), and the next prompt.submit or main-loop tool.call result consumes it.
// who is compacting. `main` is the epoch ms of the main agent's compaction proposal (null: none); `agents` has one entry per sub-agent (bare id), `at` its proposal's time, or its
// compaction's finish once `done`, and `done` is true once its compaction finished and its own briefing waits for its next tool result.
export type CompactingState = { main: number | null; agents: Record<string, { at: number; done: boolean }> }

export type PendingStart = { sessionId: string; source: string; transcriptPath: string | null; predecessorId: string | null } | null

// what the reports remember between events: what this session reported opening and still owes a close. `agents`: by activity id
// (`agent-<id>`), each running sub-agent whose start was posted, with the time (epoch ms) of its last post (the start or a liveness
// re-post); its finish removes it. `shells`: the background task ids of the shells whose start was posted and that no Stop has closed yet.
// `planId`: the plan the session was on when the
// latest of them opened, null when nothing is open: a move to another plan closes what was opened under this one first.
export type ReportState = { agents: Record<string, number>; shells: string[]; planId: number | null }

// a plan event the relay has taken from the server and not yet delivered to the session, kept in $.state so a reload of the hook module (which
// empties the module's own outbox) finds it again. The server drops every event at or below the cursor a poll presents, so this copy is the only one.
// It is listed only while it is NOT delivered: from being taken until `$.prompt.submit` (or the note append) is called for it, and again when the
// session refused it. `again`: it was delivered once at its call (its cursor is stored, maybe behind later ones), so issuing it again stores no cursor.
// `acks`: the events the record asks the session to acknowledge (empty for most records); required, so one written by the previous plugin version (which has none) is a fault when it is read back (fromPending).
export type PendingEvent = { planId: number | null; cursor: string; text: string; urgent: boolean; acks: AckRef[]; again?: true }

// one event the dashboard needs the session to acknowledge; `attempt` is how many times it has been sent (1 = the first send).
export type AckRef = { eventId: number; attempt: number }

// the acknowledgement-requiring events this module has issued and no acknowledgement has confirmed yet, as [event id, attempt] pairs oldest first, capped (ACK_IN_FLIGHT_MAX).
export type AckInFlight = [number, number][]

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
      // the sign-in request waiting for the person (its approval link and confirm code), drawn by the band; null when none.
      signInRequest: { url: string; code: string } | null
      // the plan the model's own successful plan_connect named, for the blocked view
      modelPlan: { id: number; name: string } | null
      // the model's undecided permission requests, oldest first.
      permissionRequests: PermissionRequest[]
      // the MAIN session's transcript path, as the classic events last carried it (`transcript_path`): the plan event wait carries it.
      transcript: string | null
      // the failure text of the last usage report to danxbot, null while reports are accepted (a repeat is toasted once).
      usageError: string | null
      // when the last API response arrived (epoch ms): the age of the usage figure. null until one has.
      measuredAt: number | null
      // the event relay's state (see RelayState): the events warning is built from it when it is not streaming; the band draws none of it.
      relay: RelayState
      // the events warning last toasted (null: none), so its reason is told once per transition
      eventsWarned: string | null
      // the main loop's turn as the delivery of an urgent event needs it (see TurnState).
      turn: TurnState
      // the last time stamp handed to the model (see StampState): the next one counts its +delta and its date from it.
      lastStamp: StampState
      // the disk notice last told to each agent (see DiskTold), so a tool call repeats it only on a change or after a few minutes.
      diskTold: DiskTold
      // the last disk measurement (see DiskMeasured), reused by tool calls for a minute.
      diskMeasured: DiskMeasured
      // the machine's Windows home, resolved once per session (see DiskHome).
      diskHome: DiskHome
      // the session start waiting for the next prompt or main-loop tool result (see PendingStart).
      pendingStart: PendingStart
      // the id of the session a /clear just ended (session.end), until the start of the session that replaced it takes it.
      endedSession: string | null
      // the desktop app hosts this session (the keepalive's gate): raised at a session start that lists the desktop or whose CLAUDE_CODE_ENTRYPOINT is claude-desktop, and at any desktop
      // attach, never cleared, and kept by a reload of the hooks module, whose own variables start over.
      desktopHosted: boolean
      // when the keepalive's current idle period began (epoch ms); null while no plan is followed. A reload of the hooks module resumes from it.
      idleSince: number | null
      // the person was told, once, that this dashboard has no agent-pause route (a plugin newer than the dashboard).
      olderDashboardTold: boolean
      // the person was told, once, that the desktop's Browser pane is not reachable from the plugin (the plan tab is not kept open).
      browserMissingTold: boolean
      // the leftover compaction-trigger variables of an older plugin version were cleared in this process (once; a later writer's value is never touched).
      leftoverArmingCleared: boolean
      // the percent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE holds because the plugin armed it for the sub-agents (null: it armed none); the variable lives in the process, so a reload keeps both.
      armedPercent: number | null
      // this host runs `session.compact` (raised by its first event). One of two inputs to `hostRunsSessionCompact` (the other: the engine release, `engineCompact`): when it holds, the classic PreCompact gate leaves automatic proposals to `session.compact`, and the sub-agents' percent is armed.
      sessionCompactSeen: boolean
      // what the engine's release says about `session.compact`, read once per process: 'unread' until first asked, then 'runs' (a release from 2.1.299), 'older', or 'unreadable' (the call threw or named no release).
      engineCompact: 'unread' | 'runs' | 'older' | 'unreadable'
      // the sub-agent requests claimed for sending (`<session>:<agent>` to the request's `at`), one compare-and-set before `$.session.send`; a failed send gives the claim back.
      claimedAsks: Record<string, string>
      // the release the plugin claimed to start a compaction with (one compare-and-set, so a ready starts once)
      claimedRelease: string | null
      // who is compacting, one entry per agent (see CompactingState).
      compacting: CompactingState
      // the reports' memory (see ReportState).
      reports: ReportState
      // the relay's undelivered events, in the order the server sent them (see PendingEvent).
      relayOutbox: PendingEvent[]
      // the events issued to the session whose acknowledgement call has not succeeded yet (see AckInFlight): the relay drops a re-send of one the session already holds while its turn runs.
      ackInFlight: AckInFlight
    }
  }
}
