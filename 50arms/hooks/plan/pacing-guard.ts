import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

import type { PacingVerdict } from '../../types'
import { claimSlot, releaseClaim, reportClaimFailure } from './pacing-line'
import { PACING_READ_DEADLINE_MS } from './pacing-line'
import type { PacingEnv } from './pacing-line'

// The usage-pacing guard on sub-agent spawns. The budget is a STRICT cap on SUB-AGENTS: N means exactly N sub-agents at all times; main threads are never paced.
// So a spawn does not read a count and decide for itself: it CLAIMS its slot from 50 Arms (POST /api/pacing/agents/claim, which places the
// session on its account itself and, under one lock, reads the live count and budget and takes the slot or refuses), and the plugin acts on the
// answer. `pacing-line.ts` makes the claim (one deadline-bound call); this module words a refusal, picks the haiku downgrade for a claimed spawn
// (`decideSpawn`, pure) and wires the handler (`spawnGuard`); register.tsx only wires the handler in with its dashboard call.
//
// A SCREEN DESIGNER is a spawn whose brief names the designer profile (`isDesignerBrief`). Its floor is the board's plan-design review grade (CP-167): the
// model and effort that `GET /api/quality-gates/plan-design/instruction?board=<the card's board>` answers. A designer is never moved to a smaller model:
// `decideSpawn` never downgrades it, and a designer whose spawn runs below the grade on model or effort is refused before any claim (`designerRefusal`),
// with a reason that is not a pacing refusal (it does not start with the prefix below). A grade that cannot be read refuses the start too
// (`designerGradeFailedReason`): no default floor stands in for it. The model a spawn runs on is read as the engine resolves it (`requestedModelOf`): the
// call's `model`, else the agent type's own model from its agent file (`agentFileModel`), else the parent's. Its effort is the agent type's own
// (`agentFileEffort`): a spawn call names no effort.
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

// Effort levels, lowest first.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
const effortOf = (v: unknown): Effort | null => EFFORTS.find(x => x === String(v).toLowerCase()) ?? null

// The designer's floor: the model tier and effort of the board's plan-design review grade.
export type DesignerGrade = { model: Tier; effort: Effort }

// The card a designer brief names: the word after the profile on its first line (`gate-designer CP-167`), or null when there is none.
export function designerCardOf(prompt: unknown): string | null {
  if (!isDesignerBrief(prompt)) return null
  const first = String(prompt).split(/\r?\n/).map(line => line.trim()).find(line => line !== '') as string
  return first.slice(DESIGNER_PROFILE.length).trim().split(/\s+/)[0] || null
}

// Why a designer start is refused when the board's grade cannot be read (fail closed: no default floor stands in for it).
export function designerGradeFailedReason(card: string, failure: string): string {
  return `The plan-design review grade of the board of ${card} could not be read (${failure}), so this designer start cannot be judged against it and is refused. Start it again once the dashboard answers.`
}

// Reads the grade of the board the card lives on: two dashboard calls under the one pacing deadline. Never rejects.
async function readDesignerGrade(env: PacingEnv, card: string): Promise<{ grade: DesignerGrade } | { deny: string }> {
  const failed = (why: string) => ({ deny: designerGradeFailedReason(card, why) })
  try {
    return await env.within(
      PACING_READ_DEADLINE_MS,
      (async () => {
        const issue = await env.call('GET', `/api/issues/${encodeURIComponent(card)}`, undefined, { fields: JSON.stringify({ board_id: true }) })
        if (!issue.ok || typeof issue.body?.board_id !== 'number') return failed(`the card's board was not answered: status ${issue.status}`)
        const gate = await env.call('GET', '/api/quality-gates/plan-design/instruction', undefined, { board: String(issue.body.board_id) })
        if (!gate.ok) return failed(`the gate instruction was not answered: status ${gate.status}`)
        const model = tierOf(typeof gate.body?.model === 'string' ? gate.body.model : undefined)
        const effort = effortOf(gate.body?.effort)
        if (model === null || effort === null) return failed(`the grade names model ${JSON.stringify(gate.body?.model)} and effort ${JSON.stringify(gate.body?.effort)}`)
        return { grade: { model, effort } }
      })(),
      () => failed('no answer within the deadline'),
    )
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
}

// A designer whose spawn runs below the grade, on model or effort, is refused before any slot is claimed. An unknown model name is not on the tier list, so it
// is left alone. An effort that is not known (null) is refused: the plugin cannot tell it. The reason names the grade, what the start runs on and what to
// change; it is not a pacing refusal, so it does not start with REFUSAL_PREFIX.
export function designerRefusal(grade: DesignerGrade, requestedModel: string | undefined, requestedEffort: string | null, subagentType: string): string | null {
  const tier = tierOf(requestedModel)
  const effort = effortOf(requestedEffort)
  const gradeText = `${grade.model} at ${grade.effort} effort`
  const fix = `Start the designer again on an agent type that runs on ${grade.model} or better at ${grade.effort} effort or higher (50arms:worker-${grade.model}-${grade.effort}), and drop or change any model parameter so it is not below ${grade.model}.`
  if (effort === null) {
    return `The board's plan-design review grade is ${gradeText}, and the plugin cannot tell which effort the agent type ${subagentType} runs on. ${fix}`
  }
  const modelBelow = tier !== null && TIERS.indexOf(tier) < TIERS.indexOf(grade.model)
  const effortBelow = EFFORTS.indexOf(effort) < EFFORTS.indexOf(grade.effort)
  if (!modelBelow && !effortBelow) return null
  return `The board's plan-design review grade is ${gradeText}, and this designer start runs on ${requestedModel ?? 'an unknown model'} at ${effort} effort. ${fix}`
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

// The value an agent file's frontmatter names for `key` (`model: sonnet`). Undefined when it names none or `inherit` (the parent's), or when the file has no
// frontmatter.
function frontmatterValue(text: string, key: 'model' | 'effort'): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = frontmatter === null ? null : new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(frontmatter[1])
  if (line === null) return undefined
  const value = line[1].replace(/^(['"])(.*)\1$/, '$2')
  return value === '' || value === 'inherit' ? undefined : value
}
export const agentFileModel = (text: string): string | undefined => frontmatterValue(text, 'model')
export const agentFileEffort = (text: string): string | undefined => frontmatterValue(text, 'effort')

// Why a spawn is refused when the model its agent type runs on cannot be read from the agent file (fail closed: the spawn cannot be judged).
export function agentModelFailedReason(subagentType: string, failure: string): string {
  return `The model the agent type ${subagentType} runs on could not be read from its agent file (${failure}), so this spawn cannot be judged against the budget and is refused.`
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
// What a plugin agent type runs on, read from its agent file (`agentGrade`) for a designer start. A failed read refuses the spawn (fail closed): what it
// would run on cannot be judged. An undefined answer is a type that is not the plugin's own: its model and effort cannot be told.
type Own = { model: string | null; effort: string | null }
async function readOwnGrade(env: PacingEnv, e: AgentSpawnInput): Promise<{ own: Own | undefined } | { deny: string }> {
  try {
    return { own: await env.agentGrade(e.subagentType) }
  } catch (err) {
    return { deny: agentModelFailedReason(e.subagentType, err instanceof Error ? err.message : String(err)) }
  }
}

export function spawnGuard(env: PacingEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    const designer = isDesignerBrief(e.prompt)
    // a designer below the board's grade is refused before any slot is claimed: nothing is counted, nothing is started
    if (designer) {
      const card = designerCardOf(e.prompt)
      if (card === null) return { deny: "A designer brief names its card on its first line (gate-designer <card id>); this one names none, so its board's grade cannot be read and the start is refused." }
      const graded = await readDesignerGrade(env, card)
      if ('deny' in graded) return { deny: graded.deny }
      // a fork inherits the parent's model and runs on no agent file of its own: its effort cannot be told
      let own: Own | undefined = { model: null, effort: null }
      if (!e.fork) {
        const read = await readOwnGrade(env, e)
        if ('deny' in read) return { deny: read.deny }
        own = read.own
      }
      const refusal = designerRefusal(graded.grade, requestedModelOf(e, own?.model ?? null), own?.effort ?? null, e.subagentType)
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
