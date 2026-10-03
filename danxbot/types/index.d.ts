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

// `no-mcp`: the session has no `danx-dashboard` MCP server (another repo), so the dashboard
// cannot be reached at all. It is not an error: the band shows only its Plan button.
export type PlanView = {
  phase: 'loading' | 'ready' | 'error' | 'no-mcp'
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
  listener: string | null
  refreshedAt: string | null
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
      // The band is hidden for the session (the footer entry brings it back). Its own atom: refresh
      // replaces `view` whole, so a flag inside it would be reset by every refresh.
      dismissed: boolean
      // The plan the quick-view card was opened on, or null when closed. The card shows only while this
      // equals the connected plan's id on the view drawn (quickOpenFor). A view that names a connected plan
      // (ready, or an error built after the plan was read) on another plan clears it; a view that names
      // none and is not ready (loading, no-mcp, an early error) never decides.
      quickPlanId: number | null
      expanded: number | null
      // keys of the writes under way (config busyKey): one per problem or connect
      busy: string[]
      draft: Draft | null
      talk: number | null
      // The in-app browser tab this plugin owns, so a person's own tabs are never navigated.
      tab: string | null
      // The session's title as the app last reported it, passed to `plan_connect`.
      title: string | null
    }
  }
}
