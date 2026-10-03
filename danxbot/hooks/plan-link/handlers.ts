import type { PlanRow, ProblemRow, SolutionRow, StepRow } from '../../types'

// What a drawing may do. The drawing files are pure (`$` cannot cross an import), so
// register.tsx builds this from `$` and hands it in. Each returns its work's promise, which a
// press hands back to the engine, so the engine (and `claude plugin test`) can wait for it.
export type Handlers = {
  refresh: () => Promise<unknown>
  openPane: () => Promise<unknown>
  openBrowserTab: (url: string) => Promise<unknown>
  connect: (plan: PlanRow) => Promise<unknown>
  toggleSwitch: () => Promise<unknown>
  cancelSwitch: () => Promise<unknown>
  pickPlan: (value: string) => Promise<unknown>
  toggleExpanded: (problemId: number) => Promise<unknown>
  toggleTalk: (problemId: number) => Promise<unknown>
  toggleDraft: (p: ProblemRow, solutionId: number, kind: 'note' | 'reject') => Promise<unknown>
  answer: (p: ProblemRow, body: Record<string, unknown>, label: string) => Promise<unknown>
  answerWithNote: (p: ProblemRow, s: SolutionRow, text: string, rejected: boolean) => Promise<unknown>
  checkStep: (p: ProblemRow, s: SolutionRow, step: StepRow) => Promise<unknown>
  comment: (p: ProblemRow, text: string) => Promise<unknown>
}
