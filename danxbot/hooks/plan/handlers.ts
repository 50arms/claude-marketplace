import type { ConnectedPlan, PlanRow } from '../../types'

// What a drawing may do. The drawing files are pure (`$` cannot cross an import), so
// register.tsx builds this from `$` and hands it in. Each returns its work's promise, which a
// press hands back to the engine, so the engine (and `claude plugin test`) can wait for it.
export type Handlers = {
  refresh: () => Promise<unknown>
  showPlan: () => Promise<unknown>
  dismissBand: () => Promise<unknown>
  openPane: () => Promise<unknown>
  openBrowserTab: (url: string) => Promise<unknown>
  connect: (plan: PlanRow) => Promise<unknown>
  disconnect: (plan: ConnectedPlan) => Promise<unknown>
  signIn: () => Promise<unknown>
  openPermissionRequest: () => Promise<unknown>
  toggleSwitch: () => Promise<unknown>
  cancelSwitch: () => Promise<unknown>
  pickPlan: (value: string) => Promise<unknown>
}
