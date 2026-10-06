import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import type { PacingVerdict } from '../../types'
import { peekPacing, refreshPacing, releaseSlot, report, reserveSlot } from './pacing-line'
import type { PacingEnv } from './pacing-line'

// DX-4340 (PLAN-29 R-10): the usage-pacing guard on sub-agent spawns. danxbot serves the calling session's own account's verdict at
// GET /api/pacing/line (it places the session on its account itself: no account matching here), which `pacing-line.ts` caches; this
// module reads it afresh before every `agent.spawn` (one deadline-bound read, DX-4631) and answers from that cache. A pure decision
// (`decideSpawn`) plus a thin handler (`spawnGuard`); register.tsx only wires the handler in with its dashboard call.
//
// BEHAVIOUR GUARD ONLY: it hooks `agent.spawn` and nothing else, never `tool.call`, so an agent can always save its work (commits,
// pushes, card writes) however tight the budget. It also never blocks work it cannot see: no verdict (the line's `reason` set: no usage
// report, no verdict, pacing off; the dashboard unreachable or signed out; a malformed answer; nothing cached) ALLOWS the spawn.
//
// These are the prefixes the plan-workflow skill quotes (`Usage pacing:` on a refused spawn): a change to the refusal text must update
// danxbot/skills/plan-workflow/SKILL.md in the same change.
//
// A failed or timed-out read is never silent: toasted once per distinct text and drops the verdict (no verdict allows), except that an
// unreachable dashboard is silent until a read has succeeded (see pacing-line.ts). A burst of spawns inside one turn is held to the budget:
// the spawns this guard allowed are held as reservations that raise danxbot's running count until they lapse (pacing-line.ts).

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

// "Tight": the spawn would take the last free slot under a budget (at most TIGHT_FREE_SLOTS slots free). One rule, documented here and tested.
export const TIGHT_FREE_SLOTS = 1
export function isTight(budget: number | null, running: number): boolean {
  return budget !== null && budget - running <= TIGHT_FREE_SLOTS
}

// What the plan-workflow skill quotes (see the header): the refusal the model reads starts with this.
export const REFUSAL_PREFIX = 'Usage pacing:'

function denyReason(v: PacingVerdict, why: 'level' | 'budget'): string {
  const level = v.level.replace('_', ' ')
  const budget = v.budget === null ? 'no cap' : v.budget === 0 ? 'budget 0 (start nothing new)' : `budget ${v.budget} at once`
  const reset = v.resetsAt === null ? 'its reset time is unknown' : `usage resets at ${v.resetsAt}`
  const cause = why === 'level' ? `this account is ${level}` : `${v.runningAgents} agent(s) already run on this account against ${budget}`
  return (
    `${REFUSAL_PREFIX} ${cause} (level ${level}, ${budget}; ${reset}). Do the work yourself, cheaply, in this session, or wait until the ` +
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

// Decide AND reserve, atomically: every await comes first (the refresh, the clock), then the cache is read, the decision made and the
// slot reserved with NO await between them, so parallel spawns each see the others' reservations whatever the host's concurrency.
// `slot` is the reservation to give back if the spawn does not start; null when nothing was reserved.
async function reserve(env: PacingEnv, e: AgentSpawnInput): Promise<{ decision: SpawnDecision; slot: number | null }> {
  // DX-4631: its own read every time (spawns are rare, a read is cheap, and the read has a deadline): the spawn is decided on the verdict as it
  // is now, never on one a message or a tick has since replaced.
  await refreshPacing(env, true)
  const now = await env.now()
  const pacing = peekPacing(now)
  // a fork always inherits the parent's model, so the model it would run on is the parent's
  const decision = decideSpawn(pacing?.verdict ?? null, e.fork ? e.parentModel : (e.model ?? e.parentModel))
  if (decision.kind === 'deny' || pacing === null) return { decision, slot: null }
  return { decision, slot: reserveSlot(now) }
}

// The `agent.spawn` hook. Pacing's own failures never stop a spawn: any failure to LOOK means allow (see the header), and it is told
// through the same once-per-text report as a failed read.
export function spawnGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    let decision: SpawnDecision = { kind: 'allow' }
    let slot: number | null = null
    try {
      const reserved = await reserve(env, e)
      decision = reserved.decision
      slot = reserved.slot
    } catch (err: any) {
      report(env, String(err?.message ?? err))
    }
    if (decision.kind === 'deny') return { deny: decision.reason }
    try {
      // a fork ignores `model`, so there is nothing to rewrite
      const started = await next(decision.kind === 'downgrade' && !e.fork ? { ...e, model: decision.model } : e)
      if (slot !== null && started.deny !== undefined) releaseSlot(slot)
      return started
    } catch (err) {
      if (slot !== null) releaseSlot(slot)
      throw err
    }
  }
}
