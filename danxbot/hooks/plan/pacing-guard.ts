import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import { currentPacing } from './pacing-line'
import type { PacingEnv, PacingVerdict } from './pacing-line'

// DX-4340 (PLAN-29 R-10): the usage-pacing guard on sub-agent spawns. danxbot serves the calling session's own account's verdict at
// GET /api/pacing/line (it places the session on its account itself: no account matching here), which `pacing-line.ts` caches; this
// module answers `agent.spawn` from that one cache. A pure decision (`decideSpawn`) plus a thin handler (`spawnGuard`); register.tsx
// only wires the handler in with its dashboard call.
//
// BEHAVIOUR GUARD ONLY: it hooks `agent.spawn` and nothing else, never `tool.call`, so an agent can always save its work (commits,
// pushes, card writes) however tight the budget. It also never blocks work it cannot see: no verdict (the line's `reason` set: no usage
// report, no verdict, pacing off; the dashboard unreachable or signed out; a malformed answer; nothing cached) ALLOWS the spawn. A
// failed read is never silent: it is toasted once per distinct text.

export type SpawnDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'downgrade'; model: 'haiku' }

// ---- the decision ---------------------------------------------------------------------------------------------------------------

// Model tiers, cheapest first. A spawn is only ever moved DOWN this list, never up.
const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const
type Tier = (typeof TIERS)[number]

export function tierOf(model: string | undefined): Tier | null {
  if (model === undefined) return null
  const lower = model.toLowerCase()
  return TIERS.find(t => lower.includes(t)) ?? null
}

// "Tight": the spawn would take the last free slot under a budget (budget - running <= 1). One rule, documented here and tested.
export function isTight(budget: number | null, running: number): boolean {
  return budget !== null && budget - running <= 1
}

function denyReason(v: PacingVerdict, why: 'level' | 'budget'): string {
  const level = v.level.replace('_', ' ')
  const budget = v.budget === null ? 'no cap' : v.budget === 0 ? 'budget 0 (start nothing new)' : `budget ${v.budget} at once`
  const reset = v.resetsAt === null ? 'its reset time is unknown' : `usage resets at ${v.resetsAt}`
  const cause = why === 'level' ? `this account is ${level}` : `${v.runningAgents} agent(s) already run on this account against ${budget}`
  return (
    `Usage pacing: ${cause} (level ${level}, ${budget}; ${reset}). Do the work yourself, cheaply, in this session, or wait until the ` +
    'reset. Do not retry this spawn: it will be refused again until the verdict changes.'
  )
}

// The budget's unit is the ACCOUNT's running agents (its sessions' main threads, live sub-agents and running worker dispatches), which
// the verdict carries as `runningAgents`; the plugin's own count would only be a lower bound and is not used. `requested` is the model
// the spawn would run on if left alone: the call's `model`, else the parent's (a fork always inherits the parent's).
export function decideSpawn(verdict: PacingVerdict | null, requested: string | undefined): SpawnDecision {
  if (verdict === null) return { kind: 'allow' }
  if (verdict.level !== 'on_pace') return { kind: 'deny', reason: denyReason(verdict, 'level') }
  // a null budget imposes no count cap; the level above still applies
  if (verdict.budget !== null && verdict.runningAgents >= verdict.budget) return { kind: 'deny', reason: denyReason(verdict, 'budget') }
  if (isTight(verdict.budget, verdict.runningAgents)) {
    const tier = tierOf(requested)
    // an unknown model name is left alone: it cannot be placed on the tier list, so "below it" is not knowable
    if (tier !== null && tier !== 'haiku') return { kind: 'downgrade', model: 'haiku' }
  }
  return { kind: 'allow' }
}

// The `agent.spawn` hook. Never throws: any failure to LOOK means allow (see the header), and the person is told.
export function spawnGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    let decision: SpawnDecision = { kind: 'allow' }
    try {
      const pacing = await currentPacing(env)
      // a fork always inherits the parent's model, so the model it would run on is the parent's
      decision = decideSpawn(pacing?.verdict ?? null, e.fork ? e.parentModel : (e.model ?? e.parentModel))
    } catch (err: any) {
      env.toast(`Usage pacing skipped this spawn check: ${String(err?.message ?? err).slice(0, 200)}`)
    }
    if (decision.kind === 'deny') return { deny: decision.reason }
    // a fork ignores `model`, so there is nothing to rewrite
    if (decision.kind === 'downgrade' && !e.fork) return next({ ...e, model: decision.model })
    return next(e)
  }
}
