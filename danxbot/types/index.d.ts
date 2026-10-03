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
  id: number
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
}

// `no-mcp`: the session has no `danx-dashboard` MCP server (another repo), so the dashboard
// cannot be reached at all. It is not an error: the band shows only its Plan button.
export type PlanView = {
  phase: 'loading' | 'ready' | 'error' | 'no-mcp'
  error: string | null
  connectedPlanId: number | null
  plans: PlanRow[]
  problems: ProblemRow[]
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
      busy: string | null
      draft: Draft | null
      talk: number | null
      // The in-app browser tab this plugin owns, so a person's own tabs are never navigated.
      tab: string | null
      // The session's title as the app last reported it, passed to `plan_connect`.
      title: string | null
    }
  }
}
