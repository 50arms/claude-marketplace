import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import type { PacingVerdict } from '../../types'
import { claimSlot, releaseClaim, report } from './pacing-line'
import type { PacingEnv } from './pacing-line'

// DX-4340 (PLAN-29 R-10), DX-5593: the usage-pacing guard on sub-agent spawns. The budget is a STRICT cap: N means exactly N agents at all times.
// So a spawn does not read a count and decide for itself: it CLAIMS its slot from danxbot (POST /api/pacing/agents/claim, which places the
// session on its account itself and, under one lock, reads the live count and budget and takes the slot or refuses), and the plugin acts on the
// answer. `pacing-line.ts` makes the claim (one deadline-bound call); this module decides what the answer means (`decideSpawn`, pure) and wires
// the handler (`spawnGuard`); register.tsx only wires the handler in with its dashboard call.
//
// BEHAVIOUR GUARD ONLY: it hooks `agent.spawn` and nothing else, never `tool.call`, so an agent can always save its work (commits, pushes, card
// writes) however tight the budget. It FAILS CLOSED for a signed-in session: a claim that cannot be made (the deadline passed, an error or malformed
// answer) REFUSES the spawn, because an allowed spawn there would be an agent nobody counted (the failure is toasted once per text). The allows
// without a claim are danxbot's own answer that it sees no account to cap (no usage report, no verdict, pacing off) and a session outside pacing
// (no danx-dashboard MCP server, or signed out): danxbot counts none of its agents, so refusing them would only break plain plugin use.
//
// These are the prefixes the plan-workflow skill quotes (`Usage pacing:` on a refused spawn): a change to the refusal text must update
// danxbot/skills/plan-workflow/SKILL.md in the same change.

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

// The budget's unit is the ACCOUNT's running agents (its sessions' main threads, live sub-agents and running worker dispatches), which the claim's
// answer carries as `runningAgents` (the count before this claim). `requested` is the model the spawn would run on if left alone: the call's
// `model`, else the parent's (a fork always inherits the parent's). The deny cases here only word a refusal danxbot already made; the allow case
// picks the haiku downgrade for a spawn taking the last free slot.
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

// Why a spawn is refused when its claim could not be made (fail closed).
export function claimFailedReason(failure: string): string {
  return (
    `${REFUSAL_PREFIX} the spawn could not claim its slot from danxbot (${failure}). The budget is a strict cap, so no sub-agent starts until the ` +
    'claim can be made. Do the work yourself, cheaply, in this session, or try again later.'
  )
}

// The `agent.spawn` hook.
export function spawnGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    const claim = await claimSlot(env)
    if (claim.kind === 'failed') {
      report(env, claim.failure)
      return { deny: claimFailedReason(claim.failure) }
    }
    if (claim.kind === 'refused') {
      const decision = decideSpawn(claim.pacing.verdict, e.fork ? e.parentModel : (e.model ?? e.parentModel))
      // danxbot refused the claim, so the spawn is refused whatever the plugin's own reading of the verdict says
      return { deny: decision.kind === 'deny' ? decision.reason : denyReason(claim.pacing.verdict, 'budget') }
    }
    let decision: SpawnDecision = { kind: 'allow' }
    if (claim.kind === 'claimed') decision = decideSpawn(claim.pacing.verdict, e.fork ? e.parentModel : (e.model ?? e.parentModel))
    try {
      // a fork ignores `model`, so there is nothing to rewrite
      const started = await next(decision.kind === 'downgrade' && !e.fork ? { ...e, model: decision.model } : e)
      if (claim.kind === 'claimed' && started.deny !== undefined) await releaseClaim(env, claim.claimId)
      return started
    } catch (err) {
      if (claim.kind === 'claimed') await releaseClaim(env, claim.claimId)
      throw err
    }
  }
}
