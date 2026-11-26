import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import type { PacingVerdict } from '../../types'
import { claimSlot, releaseClaim, reportClaimFailure } from './pacing-line'
import type { PacingEnv } from './pacing-line'

// The usage-pacing guard on sub-agent spawns. The budget is a STRICT cap on SUB-AGENTS: N means exactly N sub-agents at all times; main threads are never paced.
// So a spawn does not read a count and decide for itself: it CLAIMS its slot from 50 Arms (POST /api/pacing/agents/claim, which places the
// session on its account itself and, under one lock, reads the live count and budget and takes the slot or refuses), and the plugin acts on the
// answer. `pacing-line.ts` makes the claim (one deadline-bound call); this module words a refusal, picks the haiku downgrade for a claimed spawn
// (`decideSpawn`, pure) and wires the handler (`spawnGuard`); register.tsx only wires the handler in with its dashboard call.
//
// A SCREEN DESIGNER is a spawn whose brief names the designer profile (`isDesignerBrief`). A design is always drawn by Opus or a better model, so a
// designer is never moved to a smaller one: `decideSpawn` never downgrades it, and a designer whose spawn runs on a model below Opus is refused before
// any claim (`designerModelRefusal`), with a reason that is not a pacing refusal (it does not start with the prefix below). The model a spawn runs on
// is read as the engine resolves it (`requestedModelOf`): the call's `model`, else the agent type's own model from its agent file (`agentFileModel`),
// else the parent's.
//
// BEHAVIOUR GUARD ONLY: it hooks `agent.spawn` and nothing else, never `tool.call`, so an agent can always save its work (commits, pushes, card
// writes) however tight the budget. It FAILS CLOSED for a signed-in session: a claim that cannot be made (the deadline passed, an error or malformed
// answer) REFUSES the spawn, because an allowed spawn there would be an agent nobody counted (the failure is toasted once per text). The allows
// without a claim are 50 Arms' own answer that it sees no account to cap (no usage report, no verdict, pacing off) and a signed-out session:
// 50 Arms counts none of its agents. A dashboard MCP server that never connected is refused like any failed claim.
//
// These are the prefixes the plan-workflow skill quotes (`Usage pacing:` on a refused spawn): a change to the refusal text must update
// 50arms/skills/plan-workflow/SKILL.md in the same change.

export type SpawnDecision = { kind: 'allow' } | { kind: 'downgrade'; model: 'haiku' }

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
// a slot held for a woken session is not free (`reserved`).
export function isTight(budget: number | null, running: number, reserved: number): boolean {
  return budget !== null && budget - running - reserved <= TIGHT_FREE_SLOTS
}

// What the plan-workflow skill quotes (see the header): the refusal the model reads starts with this.
export const REFUSAL_PREFIX = 'Usage pacing:'

// What a paced session does: record its state on its card, pause on `pacing`, and wait; no work of its own. 50 Arms wakes it when pacing frees slots.
export const PACED_STOP = 'Record any unrecorded state on the card it concerns, pause with PUT /api/plan-sessions/me/pause {waits_on: "pacing"}, do not do the work yourself, and wait until you are told to continue.'

// What a refused session does when a LATER pacing message says sub-agents are free. It repeats 50 Arms' own on-pace text (`pacing.conduct.on_pace`: "N of M sub-agents run now, K free:
// start your waiting sub-agents now, whatever an earlier refusal counted") and agrees with the wake of a session paused on pacing: the refusal's own count is stale once that message arrives.
export const FREED_SLOTS = 'A later pacing message that says sub-agents are free ("N of M sub-agents run now, K free") is the change: then start the waiting work at once, whatever count this refusal named (50 Arms refuses the start itself if the slots are gone again).'

// the refusal the model reads, worded from the cause 50 Arms' own claim answer names (`refusal`, from its `refusalOf`), never re-derived here.
// Refusal (section 565 "Refusals" of the event-system plan): a refusal the pacing check decides, so its words stay code. It decides on the verdict of `GET /api/pacing/line` and the slot claim (`POST /api/pacing/agents/claim`).
export function denyReason(v: PacingVerdict, why: 'level' | 'budget' | 'reserved'): string {
  const level = v.level.replace('_', ' ')
  const budget = v.budget === null ? 'no cap' : v.budget === 0 ? 'budget 0 (start no sub-agent)' : `budget ${v.budget} at once`
  const reset = v.resetsAt === null ? 'its reset time is unknown' : `usage resets at ${v.resetsAt}`
  if (why === 'reserved') {
    // not full of running sub-agents: the free slots are held for sessions that were woken after waiting longer. They free within 60 seconds if unused.
    return (
      `${REFUSAL_PREFIX} ${v.subAgents} sub-agent(s) run on this account and ${v.reservedAgents} slot(s) are held for sessions that waited longer, against ${budget} ` +
      `(level ${level}; ${reset}). A held slot frees within 60 seconds if its session does not use it. ${PACED_STOP} ` +
      `Do not retry this spawn now: it will be refused until a held slot frees. ${FREED_SLOTS}`
    )
  }
  const cause = why === 'level' ? `this account is ${level}` : `${v.subAgents} sub-agent(s) already run on this account against ${budget}`
  return (
    `${REFUSAL_PREFIX} ${cause} (level ${level}, ${budget}; ${reset}). ${PACED_STOP} ` +
    `Do not retry this spawn: it will be refused again until a later pacing message changes the verdict. ${FREED_SLOTS}`
  )
}

// The budget's unit is the ACCOUNT's running sub-agents (main threads and worker dispatches are counted as `mainAgents` but never compared), which the claim's
// answer carries as `subAgents` (the count before this claim). `requested` is the model the call names (a fork: the parent's), or undefined when the call
// names none: the start then runs on its agent type's model, and haiku is the lowest tier, so it is moved to haiku whatever that model is (no agent file is
// read). A refusal never reaches here (50 Arms refuses the claim itself); this picks the haiku downgrade for a claimed spawn taking the last free slot,
// unless the spawn is a designer (never moved).
export function decideSpawn(verdict: PacingVerdict | null, requested: string | undefined, designer: boolean): SpawnDecision {
  if (verdict === null || designer) return { kind: 'allow' }
  if (isTight(verdict.budget, verdict.subAgents, verdict.reservedAgents)) {
    if (requested === undefined) return { kind: 'downgrade', model: 'haiku' }
    const tier = tierOf(requested)
    // an unknown model name is left alone: it cannot be placed on the tier list, so "below it" is not knowable
    if (tier !== null && tier !== 'haiku') return { kind: 'downgrade', model: 'haiku' }
  }
  return { kind: 'allow' }
}

// The designer profile's name: a spawn whose brief's first non-empty line starts with it followed by a space (`gate-designer <card id>`).
const DESIGNER_PROFILE = 'gate-designer'
export function isDesignerBrief(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false
  const first = prompt
    .split(/\r?\n/)
    .map(line => line.trimStart())
    .find(line => line !== '')
  return first !== undefined && first.startsWith(`${DESIGNER_PROFILE} `)
}

// A designer whose spawn runs on a model below Opus is refused before any slot is claimed. An unknown model name is not on the tier list, so it is left
// alone. The reason names the model the spawn runs on; it is not a pacing refusal, so it does not start with REFUSAL_PREFIX.
export function designerModelRefusal(requested: string | undefined): string | null {
  const tier = tierOf(requested)
  if (tier === null || tier === 'opus' || tier === 'fable') return null
  return (
    `A screen design runs on Opus or a better model, and this designer start runs on ${requested}. ` +
    'Start it again with an agent type that runs on Opus, and drop or change any model parameter so it runs on Opus.'
  )
}

// The model a spawn runs on if left alone: a fork always inherits the parent's; else the call's `model` (the Agent tool's parameter, which outranks the
// agent type's own model); else the agent type's own model (`ownModel`, null for a type whose model the plugin does not read); else the parent's.
export function requestedModelOf(e: { fork: boolean; parentModel: string; model?: string }, ownModel: string | null): string {
  if (e.fork) return e.parentModel
  return e.model ?? ownModel ?? e.parentModel
}

// The agent file of a plugin's own agent type: `<plugin>:<name>` is `<root>/agents/<name>.md` (a nested folder is a `:` in the type). Null for a type
// another plugin or the engine defines, whose file this plugin does not read.
export function ownAgentFile(pluginName: string, pluginRoot: string, subagentType: string): string | null {
  const prefix = `${pluginName}:`
  if (!subagentType.startsWith(prefix)) return null
  return `${pluginRoot}/agents/${subagentType.slice(prefix.length).split(':').join('/')}.md`
}

// The `model` an agent file's frontmatter names (`model: sonnet`). Undefined when it names none or `inherit` (the parent's model), or when the file has no
// frontmatter.
export function agentFileModel(text: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = frontmatter === null ? null : /^model:[ \t]*(.*?)[ \t]*$/m.exec(frontmatter[1])
  if (line === null) return undefined
  const model = line[1].replace(/^(['"])(.*)\1$/, '$2')
  return model === '' || model === 'inherit' ? undefined : model
}

// Why a spawn is refused when the model its agent type runs on cannot be read from the agent file (fail closed: the spawn cannot be judged).
export function agentModelFailedReason(subagentType: string, failure: string): string {
  return `The model the agent type ${subagentType} runs on could not be read from its agent file (${failure}), so this spawn cannot be judged against the budget and is refused.`
}

// Why a designer start that names no model is refused when its agent type is not one of the plugin's own: the plugin cannot read the model it runs on.
export function unknownAgentTypeModelReason(subagentType: string): string {
  return (
    `A screen design runs on Opus or a better model, and the plugin cannot tell which model the agent type ${subagentType} runs on. ` +
    'Start the designer on one of the plugin\'s Opus or better agent types (50arms:worker-opus-high, 50arms:worker-fable-high), or name Opus or better in the call\'s model parameter.'
  )
}

// Why a spawn is refused when its claim could not be made (fail closed).
// Refusal (section 565 "Refusals" of the event-system plan): the spawn guard is fail-closed when the claim cannot be made, so this refusal stays code.
export function claimFailedReason(failure: string): string {
  return (
    `${REFUSAL_PREFIX} the spawn could not claim its slot from 50 Arms (${failure}). The budget is a strict cap, so no sub-agent starts until the ` +
    'claim can be made. Record any unrecorded state on the card it concerns, pause with waits_on "pacing", and try the spawn again when told to continue.'
  )
}

// The `agent.spawn` hook.
// The model a plugin agent type runs on, read from its agent file (`agentModel`) for a designer start. A failed read refuses the spawn (fail closed): the
// model it would run on cannot be judged. An undefined model is a type that is not the plugin's own: its model cannot be told, so the caller refuses.
type OwnModel = { model: string | null | undefined } | { deny: string }
async function readOwnModel(env: PacingEnv, e: AgentSpawnInput): Promise<OwnModel> {
  try {
    return { model: await env.agentModel(e.subagentType) }
  } catch (err) {
    return { deny: agentModelFailedReason(e.subagentType, err instanceof Error ? err.message : String(err)) }
  }
}

// The agent type's model is read only for a designer start whose call names no model (a fork never reads it): it is refused below Opus before any claim.
// Every other start reads nothing, a tight one included.
const readsOwnModel = (e: AgentSpawnInput): boolean => !e.fork && e.model === undefined

export function spawnGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    const designer = isDesignerBrief(e.prompt)
    // a designer below Opus is refused before any slot is claimed: nothing is counted, nothing is started
    if (designer) {
      let ownModel: string | null = null
      if (readsOwnModel(e)) {
        const read = await readOwnModel(env, e)
        if ('deny' in read) return { deny: read.deny }
        if (read.model === undefined) return { deny: unknownAgentTypeModelReason(e.subagentType) }
        ownModel = read.model
      }
      const refusal = designerModelRefusal(requestedModelOf(e, ownModel))
      if (refusal !== null) return { deny: refusal }
    }
    const claim = await claimSlot(env)
    if (claim.kind === 'failed') {
      reportClaimFailure(env, claim.failure)
      return { deny: claimFailedReason(claim.failure) }
    }
    // 50 Arms refused the claim, so the spawn is refused, worded from 50 Arms' own cause whatever the plugin's reading of the verdict says
    if (claim.kind === 'refused') return { deny: denyReason(claim.pacing.verdict, claim.why) }
    let decision: SpawnDecision = { kind: 'allow' }
    if (claim.kind === 'claimed') {
      const verdict = claim.pacing.verdict
      decision = decideSpawn(verdict, e.fork ? e.parentModel : e.model, designer)
    }
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
