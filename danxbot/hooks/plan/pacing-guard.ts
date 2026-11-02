import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import type { PacingVerdict } from '../../types'
import { claimSlot, releaseClaim, reportClaimFailure } from './pacing-line'
import type { PacingEnv } from './pacing-line'

// The usage-pacing guard on sub-agent spawns. The budget is a STRICT cap on SUB-AGENTS: N means exactly N sub-agents at all times; main threads are never paced.
// So a spawn does not read a count and decide for itself: it CLAIMS its slot from danxbot (POST /api/pacing/agents/claim, which places the
// session on its account itself and, under one lock, reads the live count and budget and takes the slot or refuses), and the plugin acts on the
// answer. `pacing-line.ts` makes the claim (one deadline-bound call); this module words a refusal, picks the haiku downgrade for a claimed spawn (`decideSpawn`, pure), wires
// the spawn handler (`spawnGuard`) and the notice handler for a moved spawn (`spawnNotice`); register.tsx only wires those two handlers in, the spawn guard with its dashboard call.
//
// BEHAVIOUR GUARD ONLY: nothing here denies or holds a tool call, so an agent can always save its work (commits, pushes, card writes) however tight the
// budget. Only `agent.spawn` can be refused; the one `tool.call` hook (`spawnNotice`) is a pass-through that appends text after the call. The spawn guard FAILS CLOSED for a signed-in session: a claim that cannot be made (the deadline passed, an error or malformed
// answer) REFUSES the spawn, because an allowed spawn there would be an agent nobody counted (the failure is toasted once per text). The allows
// without a claim are danxbot's own answer that it sees no account to cap (no usage report, no verdict, pacing off) and a signed-out session:
// danxbot counts none of its agents. A danx-dashboard MCP server that never connected is refused like any failed claim.
//
// These are the prefixes the plan-workflow skill quotes (`Usage pacing:` on a refused spawn, `Usage pacing moved this sub-agent` on a moved one): a change to either text must update
// danxbot/skills/plan-workflow/SKILL.md in the same change.

export type SpawnDecision = { kind: 'allow' } | { kind: 'downgrade'; model: 'haiku' }

// A spawn the guard moved to haiku is told to the session that asked for it, never silent (a gate that ran below its grade must not read as one that ran at it). The spawn (`agent.spawn`) and the Agent
// tool call it belongs to (`tool.call`, `tool_use_id`) are two hooks of one call, so the first records what it changed and the second says it in
// the call's result. Module state: both hooks run within one call, and a reload between them loses only the notice. A workflow script's agent has no
// Agent call (its `tool_use_id` is the Workflow call's, shared by the run's agents), so a move there is made but NOT told.
const moved = new Map<string, { type: string; asked: string; to: string }>()

// ---- the decision ---------------------------------------------------------------------------------------------------------------

// Model tiers, cheapest first. A spawn is only ever moved DOWN this list, never up.
export const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const
type Tier = (typeof TIERS)[number]

export function tierOf(model: string | undefined): Tier | null {
  if (model === undefined) return null
  const lower = model.toLowerCase()
  return TIERS.find(t => lower.includes(t)) ?? null
}

// "Tight": the spawn would take the last free slot under a budget (at most TIGHT_FREE_SLOTS slots free). One rule, documented here and tested.
export const TIGHT_FREE_SLOTS = 1
// a slot held for a woken session is not free (`reserved`).
export function isTight(budget: number | null, running: number, reserved: number): boolean {
  return budget !== null && budget - running - reserved <= TIGHT_FREE_SLOTS
}

// What the plan-workflow skill quotes (see the header): the refusal the model reads starts with this.
export const REFUSAL_PREFIX = 'Usage pacing:'

// What a paced session does (operator rule, 2026-10-25): stop and wait. Nothing recorded, no work of its own; the pacer wakes it.
export const PACED_STOP = 'Stop and end your turn: record nothing, do not do the work yourself, and wait until you are told to continue.'

// the refusal the model reads, worded from the cause danxbot's own claim answer names (`refusal`, from its `refusalOf`), never re-derived here.
export function denyReason(v: PacingVerdict, why: 'level' | 'budget' | 'reserved'): string {
  const level = v.level.replace('_', ' ')
  const budget = v.budget === null ? 'no cap' : v.budget === 0 ? 'budget 0 (start no sub-agent)' : `budget ${v.budget} at once`
  const reset = v.resetsAt === null ? 'its reset time is unknown' : `usage resets at ${v.resetsAt}`
  if (why === 'reserved') {
    // not full of running sub-agents: the free slots are held for sessions that were woken after waiting longer. They free within 60 seconds if unused.
    return (
      `${REFUSAL_PREFIX} ${v.subAgents} sub-agent(s) run on this account and ${v.reservedAgents} slot(s) are held for sessions that waited longer, against ${budget} ` +
      `(level ${level}; ${reset}). A held slot frees within 60 seconds if its session does not use it. ${PACED_STOP} ` +
      'Do not retry this spawn now: it will be refused until a held slot frees.'
    )
  }
  const cause = why === 'level' ? `this account is ${level}` : `${v.subAgents} sub-agent(s) already run on this account against ${budget}`
  return (
    `${REFUSAL_PREFIX} ${cause} (level ${level}, ${budget}; ${reset}). ${PACED_STOP} ` +
    'Do not retry this spawn: it will be refused again until the verdict changes.'
  )
}

// The budget's unit is the ACCOUNT's running sub-agents (main threads and worker dispatches are counted as `mainAgents` but never compared), which the claim's
// answer carries as `subAgents` (the count before this claim). `requested` is the model the spawn would run on if left alone (`requestedModel`). A refusal never reaches here (danxbot refuses the claim itself); this picks the haiku
// downgrade for a claimed spawn taking the last free slot.
export function decideSpawn(verdict: PacingVerdict | null, requested: string | undefined): SpawnDecision {
  if (verdict === null) return { kind: 'allow' }
  if (isTight(verdict.budget, verdict.subAgents, verdict.reservedAgents)) {
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
    'claim can be made. Stop and end your turn, record nothing, and try the spawn again later.'
  )
}

// The model the spawn would run on if left alone: a fork's is its parent's; else the call's `model` (a `danxbot:worker` start from an Agent call always passes one, see
// worker-start.ts; a workflow-script start is the exception, so a haiku worker started from an Opus session is judged a haiku spawn); else the parent's.
export function requestedModel(e: Pick<AgentSpawnInput, 'fork' | 'model' | 'parentModel'>): string {
  return e.fork ? e.parentModel : (e.model ?? e.parentModel)
}

// What the plan-workflow skill quotes (see the header): the notice a moved spawn's Agent call carries starts with this.
export const MOVED_PREFIX = 'Usage pacing moved this sub-agent'

// `isTight` moves a spawn that takes the last free slot, so a re-run is only worth it with MORE than one slot free; whether a gate should instead wait for a
// slot when the budget never gives that is an open question of the pacing design, not worded here.
export function movedNotice(type: string, asked: string, to: string): string {
  return (
    `${MOVED_PREFIX}: you asked for ${type} on ${asked}, and it runs on ${to} (it took the last free slot under the account's budget). ` +
    'It does not run at the grade you chose. Count nothing it records as work done at that grade. Run it again at its grade only when the budget leaves more than one slot free: a spawn that takes the last free slot is moved again.'
  )
}

// The `tool.call` hook on the Agent tool: a pass-through that only appends the notice after the call. It denies nothing and rewrites nothing, so it can
// never hold a commit, push or card write.
export async function spawnNotice<E extends { tool_use_id: string }, R extends { context?: readonly string[]; deny?: string }>(e: E, next: (e: E) => Promise<R>): Promise<R> {
  const r = await next(e)
  const note = moved.get(e.tool_use_id)
  moved.delete(e.tool_use_id)
  if (note === undefined || r.deny !== undefined) return r
  return { ...r, context: [...(r.context ?? []), movedNotice(note.type, note.asked, note.to)] }
}

// The `agent.spawn` hook.
export function spawnGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    const claim = await claimSlot(env)
    if (claim.kind === 'failed') {
      reportClaimFailure(env, claim.failure)
      return { deny: claimFailedReason(claim.failure) }
    }
    // danxbot refused the claim, so the spawn is refused, worded from danxbot's own cause whatever the plugin's reading of the verdict says
    if (claim.kind === 'refused') return { deny: denyReason(claim.pacing.verdict, claim.why) }
    let decision: SpawnDecision = { kind: 'allow' }
    const asked = requestedModel(e)
    if (claim.kind === 'claimed') decision = decideSpawn(claim.pacing.verdict, asked)
    try {
      // a fork ignores `model`, and so does a resume (a hook can only refuse one), so there is nothing to rewrite and nothing to tell
      const movedTo = decision.kind === 'downgrade' && !e.fork && !e.resume ? decision.model : null
      const started = await next(movedTo !== null ? { ...e, model: movedTo } : e)
      if (claim.kind === 'claimed' && started.deny !== undefined) await releaseClaim(env, claim.claimId)
      // only a spawn that started was moved: a refused one has no sub-agent to tell the asker about. A workflow agent's move is not told (see `moved`)
      if (movedTo !== null && e.workflow === undefined && started.deny === undefined) moved.set(e.tool_use_id, { type: e.subagentType, asked, to: movedTo })
      return started
    } catch (err) {
      if (claim.kind === 'claimed') await releaseClaim(env, claim.claimId)
      throw err
    }
  }
}
