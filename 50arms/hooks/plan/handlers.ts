import type { BandHold } from './hold'

// What a drawing may do. The drawing files are pure (`$` cannot cross an import), so
// register.tsx builds this from `$` and hands it in. Each returns its work's promise, which a
// press hands back to the engine, so the engine (and `claude plugin test`) can wait for it.
export type Handlers = {
  showPlan: () => Promise<unknown>
  dismissBand: () => Promise<unknown>
  disconnect: (hold: BandHold) => Promise<unknown>
  signIn: () => Promise<unknown>
}
