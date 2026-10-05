import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'

// DX-4340 (PLAN-29 R-10): the usage-pacing guard on sub-agent spawns. danxbot's 10-minute tick stores a verdict per Claude account
// (GET /api/pacing/verdicts, DX-4338); this module caches it and answers `agent.spawn` from the cache. Pure decision (`decideSpawn`) plus
// a thin handler (`spawnGuard`); register.tsx only wires the handler in with its dashboard call.
//
// BEHAVIOUR GUARD ONLY: it hooks `agent.spawn` and nothing else, never `tool.call`, so an agent can always save its work (commits,
// pushes, card writes) however tight the budget. It also never blocks work it cannot see: no verdict (pacing off for every limit, the
// dashboard unreachable or signed out, a malformed answer, nothing cached) ALLOWS the spawn. A failed read is never silent: it is
// toasted once per distinct text, the way the usage report's failures are.

export type PacingLevel = 'on_pace' | 'over_pace' | 'critical'
const LEVELS: readonly PacingLevel[] = ['on_pace', 'over_pace', 'critical']

// One account's verdict as the guard needs it: the ONLY shape the decision reads, so a DX-4338 field rename touches `parseVerdicts` alone
// (built against origin/card/DX-4338 9247e5cec). `budget`: null = no cap, 0 = start nothing new, n = most agents running at once across the
// whole ACCOUNT. `activeAgents` is the account's running agents as the last tick counted them (`active_agents`), null when the verdict has none.
export type PacingVerdict = { account: string; level: PacingLevel; budget: number | null; resetsAt: string | null; activeAgents: number | null }

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

function denyReason(v: PacingVerdict, running: number, why: 'level' | 'budget'): string {
  const level = v.level.replace('_', ' ')
  const budget = v.budget === null ? 'no cap' : v.budget === 0 ? 'budget 0 (start nothing new)' : `budget ${v.budget} at once`
  const reset = v.resetsAt === null ? 'its reset time is unknown' : `usage resets at ${v.resetsAt}`
  const cause = why === 'level' ? `this account is ${level}` : `${running} agent(s) already run on this account against ${budget}`
  return (
    `Usage pacing: ${cause} (level ${level}, ${budget}; ${reset}). Do the work yourself, cheaply, in this session, or wait until the ` +
    'reset. Do not retry this spawn: it will be refused again until the verdict changes.'
  )
}

// The budget's unit is the account's running agents, so `running` is the verdict's `activeAgents`; only when the verdict lacks it is
// `localRunning` (this session's own running sub-agents) used, as a documented LOWER bound of the account's count.
// `requested` is the model the spawn would run on if left alone: the call's `model`, else the parent's (a fork always inherits the parent's).
export function decideSpawn(verdict: PacingVerdict | null, localRunning: number, requested: string | undefined): SpawnDecision {
  if (verdict === null) return { kind: 'allow' }
  const running = verdict.activeAgents ?? localRunning
  if (verdict.level !== 'on_pace') return { kind: 'deny', reason: denyReason(verdict, running, 'level') }
  if (verdict.budget !== null && running >= verdict.budget) return { kind: 'deny', reason: denyReason(verdict, running, 'budget') }
  if (isTight(verdict.budget, running)) {
    const tier = tierOf(requested)
    // an unknown model name is left alone: it cannot be placed on the tier list, so "below it" is not knowable
    if (tier !== null && tier !== 'haiku') return { kind: 'downgrade', model: 'haiku' }
  }
  return { kind: 'allow' }
}

// ---- reading the verdicts -------------------------------------------------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === 'string'

// `body` of GET /api/pacing/verdicts: `{ verdicts: [{ account, level, budget, binding_limit, limits: [{ limit, resets_at }] }] }`.
// A row it cannot read makes the whole read an error string (never a guessed verdict).
export function parseVerdicts(body: any): PacingVerdict[] | string {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.verdicts)) return 'the pacing verdicts answer has no verdicts list'
  const out: PacingVerdict[] = []
  for (const raw of body.verdicts) {
    if (raw === null || typeof raw !== 'object' || !isString(raw.account)) return 'a pacing verdict with no account'
    if (!LEVELS.includes(raw.level)) return `${raw.account} has no valid level`
    if (raw.budget !== null && !(Number.isInteger(raw.budget) && raw.budget >= 0)) return `${raw.account} has no valid budget`
    const limits: any[] = Array.isArray(raw.limits) ? raw.limits : []
    // the limit that decided the verdict names the reset the person is waiting for
    const decider = limits.find(l => l?.limit === raw.binding_limit)
    out.push({
      account: raw.account,
      level: raw.level,
      budget: raw.budget,
      resetsAt: decider !== undefined && isString(decider.resets_at) ? decider.resets_at : null,
      activeAgents: Number.isInteger(raw.active_agents) && raw.active_agents >= 0 ? raw.active_agents : null,
    })
  }
  return out
}

// ---- which account is this session's ---------------------------------------------------------------------------------------------

// Tighter first: a higher level, then a smaller budget (null, no cap, is the loosest).
function tighterFirst(a: PacingVerdict, b: PacingVerdict): number {
  return LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || (a.budget ?? Infinity) - (b.budget ?? Infinity)
}

const MINUTE_MS = 60_000
// danxbot's own grouping key (src/issues/usage-accounts.ts minuteKey): a reset time rounded to the minute.
export function minuteKey(iso: string): string | null {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(Math.round(t / MINUTE_MS) * MINUTE_MS).toISOString()
}

export type OwnAccount = { accountUuid?: string; weeklyResetsAt?: string; fiveHourResetsAt?: string }

// DX-4340 account choice: danxbot places a session on an account from what the session reported (DX-4336): `uuid:<account uuid>` when a
// desktop-hosted session carries CLAUDE_CODE_ACCOUNT_UUID, else `weekly:<weekly reset minute>` (optionally `|five_hour:<minute>`). The guard
// derives the same keys from the session's own windows and matches them. When no key matches (an operator override renamed the account,
// the session has no figure, a 0% weekly window) it uses the TIGHTEST verdict, so an unplaceable session is never paced looser than the
// tightest account. Null when there are no verdicts.
export function pickVerdict(verdicts: readonly PacingVerdict[], own: OwnAccount): PacingVerdict | null {
  if (verdicts.length === 0) return null
  const wanted: string[] = []
  if (own.accountUuid !== undefined && own.accountUuid !== '') wanted.push(`uuid:${own.accountUuid}`)
  const week = own.weeklyResetsAt === undefined ? null : minuteKey(own.weeklyResetsAt)
  const five = own.fiveHourResetsAt === undefined ? null : minuteKey(own.fiveHourResetsAt)
  if (week !== null && five !== null) wanted.push(`weekly:${week}|five_hour:${five}`)
  if (week !== null) wanted.push(`weekly:${week}`)
  for (const key of wanted) {
    const hit = verdicts.find(v => v.account === key)
    if (hit !== undefined) return hit
  }
  if (week !== null) {
    // a weekly group the dashboard split by five-hour reset, where this session's own five-hour reset is missing or moved: it is one of
    // the group's accounts, and the tightest of them stands
    const group = verdicts.filter(v => v.account.startsWith(`weekly:${week}|`))
    if (group.length > 0) return [...group].sort(tighterFirst)[0]
  }
  return [...verdicts].sort(tighterFirst)[0]
}

// ---- the cache and the handler --------------------------------------------------------------------------------------------------

export type Call = (method: string, path: string) => Promise<{ ok: boolean; status: number; body: any; unreachable?: boolean }>

export const VERDICTS_PATH = '/api/pacing/verdicts'
// The verdict only changes at danxbot's 10-minute tick, so a minute-old cache is current; a cache this old is not trusted at all.
export const VERDICT_REFRESH_MS = 60_000
export const VERDICT_EXPIRY_MS = 30 * 60_000
const ERROR_MAX = 200

type Cache = { verdicts: PacingVerdict[]; fetchedAt: number }
// Module state: a reload starts it over, and the next spawn refetches.
let cache: Cache | null = null
let lastError: string | null = null
let inflight: Promise<void> | null = null

// The verdicts a reader may trust now (none once the cache has expired). A later `classic.SubagentStart` pacing line reads this same cache.
export function cachedVerdicts(nowMs: number): readonly PacingVerdict[] {
  return cache !== null && nowMs - cache.fetchedAt <= VERDICT_EXPIRY_MS ? cache.verdicts : []
}
export function resetPacingCache(): void {
  cache = null
  lastError = null
  inflight = null
}

// The engine calls the guard needs. Closures built in register.tsx, because the engine follows `$` only into a function in the same file:
// this module never holds `$`, only what the closures return.
export type GuardEnv = {
  now: () => Promise<number>
  call: Call
  usage: () => Promise<{ rateLimits?: readonly { kind: string; resetsAt?: string }[] }>
  accountUuid: () => Promise<string | undefined>
  agents: () => Promise<readonly { type: string; status: string }[]>
  toast: (text: string) => void
}

async function fetchVerdicts(env: GuardEnv): Promise<void> {
  let failure: string | null = null
  try {
    const r = await env.call('GET', VERDICTS_PATH)
    // a session on another repo has no danxbot dashboard: nothing to pace against, and nothing to complain about
    if (r.unreachable) return
    if (!r.ok) failure = `the pacing verdicts read answered ${r.status}`
    else {
      const parsed = parseVerdicts(r.body)
      if (typeof parsed === 'string') failure = parsed
      else cache = { verdicts: parsed, fetchedAt: await env.now() }
    }
  } catch (err: any) {
    failure = String(err?.message ?? err)
  }
  failure = failure === null ? null : failure.slice(0, ERROR_MAX)
  if (failure === lastError) return
  lastError = failure
  // a failed read keeps the last good cache until it expires; either way the spawn goes on, and the person is told once
  if (failure !== null) env.toast(`Usage pacing could not read its verdict (spawns are not paced until it can): ${failure}`)
}

// Refetch when the cache is a minute old; concurrent spawns share one read.
async function refreshIfStale(env: GuardEnv): Promise<void> {
  const now = await env.now()
  if (cache !== null && now - cache.fetchedAt < VERDICT_REFRESH_MS) return
  inflight ??= fetchVerdicts(env).finally(() => void (inflight = null))
  await inflight
}

async function ownAccount(env: GuardEnv): Promise<OwnAccount> {
  try {
    const limits = (await env.usage()).rateLimits ?? []
    return {
      accountUuid: await env.accountUuid(),
      weeklyResetsAt: limits.find(l => l.kind === 'seven_day')?.resetsAt,
      fiveHourResetsAt: limits.find(l => l.kind === 'five_hour')?.resetsAt,
    }
  } catch {
    // no usage reading on this host: the account cannot be placed, so pickVerdict falls back to the tightest verdict
    return {}
  }
}

// Sub-agents of this session running now (a teammate is not one); the one being spawned has not started, so it is not counted.
async function runningSubagents(env: GuardEnv): Promise<number> {
  return (await env.agents()).filter(a => a.type !== 'teammate' && a.status === 'running').length
}

// The `agent.spawn` hook. Never throws: any failure to LOOK means allow (see the header), and the person is told.
export function spawnGuard(env: GuardEnv) {
  return async (e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<AgentSpawnResult>): Promise<AgentSpawnResult> => {
    let decision: SpawnDecision = { kind: 'allow' }
    try {
      await refreshIfStale(env)
      const verdict = pickVerdict(cachedVerdicts(await env.now()), await ownAccount(env))
      // a fork always inherits the parent's model, so the model it would run on is the parent's
      decision = decideSpawn(verdict, await runningSubagents(env), e.fork ? e.parentModel : (e.model ?? e.parentModel))
    } catch (err: any) {
      env.toast(`Usage pacing skipped this spawn check: ${String(err?.message ?? err).slice(0, ERROR_MAX)}`)
    }
    if (decision.kind === 'deny') return { deny: decision.reason }
    // a fork ignores `model`, so there is nothing to rewrite
    if (decision.kind === 'downgrade' && !e.fork) return next({ ...e, model: decision.model })
    return next(e)
  }
}
