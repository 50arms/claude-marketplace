export type PlanRow = {
  id: number
  ref: string
  name: string
  status: string
  needsYou: number
}

export type StepRow = {
  id: number
  label: string
  title: string
  description: string
  checked: boolean
  steps: StepRow[]
}

export type SolutionRow = {
  id: number
  title: string
  body: string
  pro: string
  con: string
  recommended: boolean
  steps: StepRow[]
}

export type CommentRow = {
  // as the API returns it (a string)
  id: string
  author: string
  at: string
  text: string
}

export type ProblemRow = {
  id: number
  cardId: string
  cardTitle: string
  priority: number
  type: 'question' | 'action'
  statement: string
  summary: string | null
  context: string | null
  updatedAt: string
  solutions: SolutionRow[]
  comments: CommentRow[]
  // Comments on the card the API did not return (it pages them): the true count is at least
  // comments.length and at most comments.length + moreComments.
  moreComments: number
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
// state `healthy` is a working bridge; `nextStep` is the server's own wording (null when it has none).
export type ListenerStatus = { state: string; nextStep: string | null }

// `no-mcp`: the session has no `danx-dashboard` MCP server (another repo), so the dashboard
// cannot be reached at all. It is not an error: the band shows only its Panel button.
// `signed-out` (DX-4423): the server is there but the session holds no dashboard key (lapsed, or never approved):
// the band and pane say so and offer Sign in, never the server's agent-facing text.
// `key-revoked` (DX-4418): a person revoked the session's key (`revokedBy`): the band and pane say so and offer NO
// Sign in, because a revoked agent must stop.
export type PlanView = {
  phase: 'loading' | 'ready' | 'error' | 'no-mcp' | 'signed-out' | 'key-revoked'
  error: string | null
  connected: ConnectedPlan | null
  plans: PlanRow[]
  problems: ProblemRow[]
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
  // DX-4448: the issue prefixes (`DX`, `SG`) of the dashboard's boards, read at refresh from GET /api/boards, so a card id in an
  // assistant reply can be drawn as a link with no call at draw time. Empty when not connected or the boards call failed.
  cardPrefixes: string[]
  // The event bridge as GET /api/plans answers it (`sessionListenerAttached`): the server's health state and
  // its next step; null when the answer carries none (a session on no plan, or no session row).
  listener: ListenerStatus | null
  refreshedAt: string | null
  // DX-4423: the plan this session was on when it was signed out, for Sign in to ask for again; null when not known.
  resumePlan: number | null
  // DX-4418: who revoked the key, on a `key-revoked` view; null on every other.
  revokedBy: string | null
}

// What the operator is composing on one problem: a note on a solution, or a rejection reason.
export type Draft = {
  problemId: number
  kind: 'note' | 'reject'
  solutionId: number
}

// Refresh coalescing: one load in flight, a forced refresh asked meanwhile (`again`) runs once more.
export type RefreshGate = {
  inFlight: boolean
  again: boolean
  at: number | null
}

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
      expanded: number | null
      // keys of the writes under way (config busyKey): one per problem or connect
      busy: string[]
      draft: Draft | null
      talk: number | null
      // The in-app browser tab this plugin owns, so a person's own tabs are never navigated.
      tab: string | null
      // The session's title as the app last reported it, passed to `plan_connect`.
      title: string | null
      // DX-4391: the approval URL last opened, so one request opens its page once.
      approvalOpened: string | null
    }
  }
}
