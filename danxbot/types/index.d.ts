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
  status: string | null
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
