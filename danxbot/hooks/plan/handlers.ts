import type { ConnectedPlan, PlanRow, ProblemRow, SolutionRow, StepRow } from '../../types'

// What a drawing may do. The drawing files are pure (`$` cannot cross an import), so
// register.tsx builds this from `$` and hands it in. Each returns its work's promise, which a
// press hands back to the engine, so the engine (and `claude plugin test`) can wait for it.
// Every answer's body and label is built in register.tsx, in one place: the drawing only says
// which answer the operator gave.
export type Handlers = {
  refresh: () => Promise<unknown>
  showPlan: () => Promise<unknown>
  dismissBand: () => Promise<unknown>
  openPane: () => Promise<unknown>
  openBrowserTab: (url: string) => Promise<unknown>
  connect: (plan: PlanRow) => Promise<unknown>
  disconnect: (plan: ConnectedPlan) => Promise<unknown>
  toggleSwitch: () => Promise<unknown>
  cancelSwitch: () => Promise<unknown>
  pickPlan: (value: string) => Promise<unknown>
  toggleExpanded: (problemId: number) => Promise<unknown>
  toggleTalk: (problemId: number) => Promise<unknown>
  toggleDraft: (p: ProblemRow, solutionId: number, kind: 'note' | 'reject') => Promise<unknown>
  useSolution: (p: ProblemRow, s: SolutionRow) => Promise<unknown>
  useSolutionWithNote: (p: ProblemRow, s: SolutionRow, note: string) => Promise<unknown>
  rejectSolution: (p: ProblemRow, s: SolutionRow, reason: string) => Promise<unknown>
  answerFreeform: (p: ProblemRow, text: string) => Promise<unknown>
  checkStep: (p: ProblemRow, s: SolutionRow, step: StepRow) => Promise<unknown>
  comment: (p: ProblemRow, text: string) => Promise<unknown>
}
