import { errText } from './load'
import type { Api } from './load'
import { isSignedOut } from './mcp'
import type { UsageBody } from './usage'

// DX-4340 (PLAN-29 section 3): the ONE pacing cache. danxbot serves the calling session's own account's verdict, and the one-sentence line
// a new sub-agent is handed, at GET /api/pacing/line (the account is placed server-side from the x-danx-session-id header the dashboard
// MCP sends; src/team-pacing/session-pacing.ts). Both consumers read this cache: the `agent.spawn` guard (pacing-guard.ts) and the
// SubagentStart pacing line (register.tsx). No account matching happens in the plugin.
//
// Unknown is explicit on the wire (`reason` set, every other field null: no session, no usage report, no verdict, pacing off) and means
// the guard allows and no line is handed.
//
// A failed read is never silent: one toast per distinct text. It DROPS the cached verdict (DX-4631: an answer whose freshness is unknown is
// no answer, so the sub-agent line is withheld), and the unforced reads (the sub-agent line) do not retry it for PACING_REFRESH_MS, so each
// sub-agent start does not re-hit a dead route. A read decides no spawn (DX-5593: the spawn claim below does). The one exception is an unreachable
// danx-dashboard MCP server (a session whose danx-dashboard server has not connected, as in reportUsage and DX-3421): that is silent and not backed off,
// the next read simply looks again, until a read has succeeded in this session. After a success it is a failure like any other.

import type { LimitReadout, PacingLevel, PacingLimitKey, PacingReadout, PacingState, PacingVerdict, SpendFigure } from '../../types'

const LEVELS: readonly PacingLevel[] = ['on_pace', 'over_pace', 'critical']
const STATES: readonly PacingState[] = ['spare', 'short', 'hold', 'stop']
const LIMIT_KEYS: readonly PacingLimitKey[] = ['five_hour', 'weekly', 'spend']

// The verdict as the guard reads it (`PacingVerdict`, types/index.d.ts, shared with the usage pacing) and danxbot's one-sentence line.
// `spend` (DX-4595) is the server's own pricing of the account's spend limit, or null when it has none; the plugin never computes one.
// `readout` (DX-4656) is the server's per-limit state and headroom with its worst limit, exactly as answered.
export type Pacing = { verdict: PacingVerdict; line: string; spend: SpendFigure | null; readout: PacingReadout }

export type PacingCall = (method: string, path: string, body?: object) => Promise<Api>
// The engine calls pacing makes, as closures built in register.tsx (the engine follows `$` only into a function in that file).
// `within` is the plugin's one deadline helper (register.tsx `withinDeadline`): `work`'s answer, or `late()` when `ms` pass first.
export type PacingEnv = {
  now: () => Promise<number>
  within: <T>(ms: number, work: Promise<T>, late: () => T) => Promise<T>
  call: PacingCall
  // DX-5593: the session's latest usage reading as the usage report's body, or null when it has none (a session off a subscription, a reading that
  // fails). The spawn claim carries it. Never rejects.
  reading: () => Promise<UsageBody | null>
  // DX-5593 (B1): whether this session is KNOWN to be signed in: a loaded plan view, or any dashboard call that succeeded in this session. Never rejects.
  signedIn: () => Promise<boolean>
  // the wait between looks for a server that has not connected yet; rejects when the plugin is unloaded
  sleep: (ms: number) => Promise<void>
  toast: (text: string) => void
}

export const LINE_PATH = '/api/pacing/line'
// danxbot changes the verdict only at its 10-minute tick; the plugin cannot hear `pacing-verdicts:updated` (a hooks module has no
// dashboard event source), so the cache is read on session start, by the usage pacing poll every minute, by the sub-agent line when it is a minute
// old, and by the spawn guard before every decision (`refreshPacing`).
export const PACING_REFRESH_MS = 60_000
export const PACING_EXPIRY_MS = 30 * 60_000
// DX-4631: every `refreshPacing` has ONE deadline, covering its wait for a read already out AND its own read (two sequential bounds could
// outrun the engine's hook budget). A read that has not answered by then is a failed read (toasted, the cached verdict dropped) and frees
// the next read: a hung dashboard call can neither hold `inflight` for ever nor stall the spawn that is waiting on it.
export const PACING_READ_DEADLINE_MS = 5_000
const ERROR_MAX = 200

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

// DX-4595: `spend` of a known answer: null, or the server's figure. Absent is an error (one canonical shape).
function parseSpendFigure(raw: any): SpendFigure | null | { error: string } {
  if (raw === null) return null
  if (raw === undefined || typeof raw !== 'object') return { error: 'the pacing line answer has no valid spend' }
  if (!finite(raw.used_percent) || !LEVELS.includes(raw.level) || typeof raw.resets_at !== 'string' || !finite(raw.spent_usd) || !finite(raw.budget_usd)) return { error: 'the pacing line answer has no valid spend' }
  return { usedPercent: raw.used_percent, level: raw.level, resetsAt: raw.resets_at, spentUsd: raw.spent_usd, budgetUsd: raw.budget_usd }
}

// DX-4656: `limits` and `worst_limit` of a known answer. Absent or malformed is an error (one canonical shape), never a made-up readout.
function parseReadout(body: any): PacingReadout | { error: string } {
  const bad = { error: 'the pacing line answer has no valid limits' }
  if (!Array.isArray(body.limits) || body.limits.length === 0 || !LIMIT_KEYS.includes(body.worst_limit)) return bad
  const limits: LimitReadout[] = []
  for (const raw of body.limits) {
    if (raw === null || typeof raw !== 'object') return bad
    if (!LIMIT_KEYS.includes(raw.limit) || !LEVELS.includes(raw.level) || !STATES.includes(raw.state) || typeof raw.resets_at !== 'string') return bad
    if (!Number.isInteger(raw.headroom_minutes) || !Number.isInteger(raw.resets_in_minutes) || raw.resets_in_minutes < 0) return bad
    if (!finite(raw.used_percent) || !finite(raw.target_percent) || !finite(raw.critical_percent)) return bad
    limits.push({
      limit: raw.limit,
      level: raw.level,
      state: raw.state,
      headroomMinutes: raw.headroom_minutes,
      resetsInMinutes: raw.resets_in_minutes,
      usedPercent: raw.used_percent,
      targetPercent: raw.target_percent,
      criticalPercent: raw.critical_percent,
      resetsAt: raw.resets_at,
    })
  }
  if (!limits.some(l => l.limit === body.worst_limit)) return bad
  return { limits, worst: body.worst_limit }
}

// `body` of GET /api/pacing/line: a known answer, null for the explicit unknown, an error for anything else.
export function parsePacing(body: any): Pacing | null | { error: string } {
  if (body === null || typeof body !== 'object') return { error: 'the pacing line answer is not an object' }
  if (body.level === null && body.line === null) return typeof body.reason === 'string' ? null : { error: 'the pacing line answer has no verdict and no reason' }
  if (!LEVELS.includes(body.level)) return { error: 'the pacing line answer has no valid level' }
  if (body.budget !== null && !(Number.isInteger(body.budget) && body.budget >= 0)) return { error: 'the pacing line answer has no valid budget' }
  if (!Number.isInteger(body.running_agents) || body.running_agents < 0) return { error: 'the pacing line answer has no running_agents' }
  if (typeof body.line !== 'string' || body.line.trim() === '') return { error: 'the pacing line answer has no readable line' }
  const spend = parseSpendFigure(body.spend)
  if (spend !== null && 'error' in spend) return spend
  const readout = parseReadout(body)
  if ('error' in readout) return readout
  return {
    spend,
    readout,
    verdict: { level: body.level, budget: body.budget, resetsAt: typeof body.resets_at === 'string' ? body.resets_at : null, runningAgents: body.running_agents },
    line: body.line,
  }
}

// `pacing` null = danxbot answered unknown. A module-state cache, reset at every session start (resetPacing).
type Cache = { pacing: Pacing | null; fetchedAt: number }
let cache: Cache | null = null
// when the last read was ATTEMPTED and the server was reachable (success or failure): the back-off clock
let lastReadAt: number | null = null
// a read has succeeded in this session: from then on an unreachable server is worth a toast
let hasSucceeded = false
let lastError: string | null = null
// the same for the spawn claim's refusals, told in their own words (B2)
let lastClaimError: string | null = null
let inflight: Promise<void> | null = null
// bumped by every reset: a read that was in flight across one must not write the new session's state
let generation = 0

export function resetPacing(): void {
  generation++
  cache = null
  lastReadAt = null
  hasSucceeded = false
  lastError = null
  lastClaimError = null
  inflight = null
}

// One toast per distinct failure text, for every failure pacing has (a read, the clock, a hook error).
export function report(env: PacingEnv, failure: string): void {
  failure = failure.slice(0, ERROR_MAX)
  if (failure === lastError) return
  lastError = failure
  env.toast(`Usage pacing could not be read (sub-agents get no pacing line until it can): ${failure}`)
}

// The read's outcome when the deadline passes first. The loser is never read: a late answer of a timed-out call is dropped.
const TIMED_OUT = Symbol('timed out')

// A failed read: told once per text, and the cached verdict dropped (no verdict: no sub-agent line).
function failRead(env: PacingEnv, failure: string): void {
  cache = null
  report(env, failure)
}

async function fetchPacing(env: PacingEnv, ms: number): Promise<void> {
  const gen = generation
  try {
    const at = await env.now()
    const r = await env.within<Api | typeof TIMED_OUT>(ms, env.call('GET', LINE_PATH), () => TIMED_OUT)
    // a session start came while this read was out: its answer is the previous session's
    if (gen !== generation) return
    if (r === TIMED_OUT) {
      lastReadAt = at
      return failRead(env, `the pacing line read took longer than its ${PACING_READ_DEADLINE_MS} ms deadline`)
    }
    if (r.unreachable) {
      // silent and not backed off until a read has succeeded (see the header)
      cache = null
      if (hasSucceeded) report(env, 'the danx-dashboard MCP server is not reachable from this session')
      return
    }
    lastReadAt = at
    // DX-4982: a call auto mode refused (errText: the sentence and fix) or that never reached the server says why, never `answered 0`
    if (!r.ok) return failRead(env, r.status === 0 ? errText(r) : `the pacing line read answered ${r.status}`)
    const parsed = parsePacing(r.body)
    if (parsed !== null && 'error' in parsed) return failRead(env, parsed.error)
    cache = { pacing: parsed, fetchedAt: at }
    hasSucceeded = true
    // a good read clears the failure, so the same failure is told again if it comes back
    lastError = null
  } catch (err: any) {
    if (gen === generation) failRead(env, String(err?.message ?? err))
  }
}

// Read now when `force`, else when the last reachable read attempt is a minute old; concurrent unforced callers share one read. A forced
// read never shares one that is already out: that read was asked before whatever forces this one, so its answer may predate it; it waits for
// that read (which settles within its own deadline: `fetchPacing` always does) and then asks again with what is left of THIS call's one
// deadline. Never rejects: a clock that fails is a failed read like any other.
export async function refreshPacing(env: PacingEnv, force = false): Promise<void> {
  try {
    const startedAt = await env.now()
    if (!force && lastReadAt !== null && startedAt - lastReadAt < PACING_REFRESH_MS) return
    if (force && inflight !== null) await inflight
    const left = PACING_READ_DEADLINE_MS - ((await env.now()) - startedAt)
    if (left <= 0) {
      lastReadAt = startedAt
      return failRead(env, `the pacing line read took longer than its ${PACING_READ_DEADLINE_MS} ms deadline`)
    }
    inflight ??= fetchPacing(env, left).finally(() => void (inflight = null))
    await inflight
  } catch (err: any) {
    report(env, String(err?.message ?? err))
  }
}

// SYNCHRONOUS: the session's pacing at `nowMs` (null when unknown or expired), as last read. A failed read dropped the answer (no verdict).
// DX-5593: the count in it is danxbot's live count; the plugin keeps no count of its own (no reservations, no local agent list).
export function peekPacing(nowMs: number): Pacing | null {
  if (cache === null || cache.pacing === null || nowMs - cache.fetchedAt > PACING_EXPIRY_MS) return null
  return cache.pacing
}

// DX-5593: the spawn claim. The budget is a STRICT cap and the one count lives in danxbot, so a spawn takes its slot there, atomically
// (POST /api/pacing/agents/claim: the same body as the line plus {claimed, claim_id}); the plugin decides nothing from a count it holds.
// `unknown`: danxbot sees no account to cap, or the session is outside pacing altogether (signed out, or its danx-dashboard MCP server NEVER
// connected): allow, nothing claimed, because danxbot counts no agent of a session it does not know. `failed`: the claim could not be made
// (deadline, error answer, malformed answer, or the server of a session KNOWN to be signed in is unreachable) and the spawn is REFUSED: an allowed
// spawn there would be an agent nobody counted (DX-5593 notes 18330, 18725). Whether a session is outside pacing is a fact about the session, never
// about the connection: a session that was signed in stays inside pacing when its server drops.
export const CLAIM_PATH = '/api/pacing/agents/claim'
// how often a server that has not connected yet is looked for again, inside the claim's one PACING_READ_DEADLINE_MS
export const CONNECT_POLL_MS = 500
export type Claim =
  | { kind: 'claimed'; pacing: Pacing; claimId: string }
  | { kind: 'refused'; pacing: Pacing }
  | { kind: 'unknown' }
  | { kind: 'failed'; failure: string }

export function parseClaim(body: any): Claim {
  const pacing = parsePacing(body)
  if (pacing === null) return body.claimed === false && body.claim_id === null ? { kind: 'unknown' } : { kind: 'failed', failure: 'the claim answer has no valid outcome' }
  if ('error' in pacing) return { kind: 'failed', failure: pacing.error }
  if (body.claimed === true && typeof body.claim_id === 'string' && body.claim_id !== '') return { kind: 'claimed', pacing, claimId: body.claim_id }
  if (body.claimed === false && body.claim_id === null) return { kind: 'refused', pacing }
  return { kind: 'failed', failure: 'the claim answer has no valid outcome' }
}

// One deadline-bound claim. Never rejects. A good answer also replaces the cache, so the sub-agent's pacing line is the one the claim saw.
export async function claimSlot(env: PacingEnv): Promise<Claim> {
  try {
    const startedAt = await env.now()
    // DX-5593 (N2): the claim carries the session's latest reading, the body of the usage report, and danxbot stores it under the claim's own lock before
    // judging the claim. The first report goes out fire-and-forget (and not at all while the plan view loads), so a new session's first spawns would
    // otherwise meet a session danxbot has not placed on its account: unknown, allowed, nothing claimed. One request, no ordering against the report.
    let usage: UsageBody | null = null
    try {
      usage = await env.reading()
    } catch {
      /* a reading that cannot be taken is sent without: the claim is judged on what danxbot already holds */
    }
    const late = `the spawn claim took longer than its ${PACING_READ_DEADLINE_MS} ms deadline`
    for (;;) {
      const left = PACING_READ_DEADLINE_MS - ((await env.now()) - startedAt)
      if (left <= 0) return { kind: 'failed', failure: late }
      const r = await env.within<Api | typeof TIMED_OUT>(left, env.call('POST', CLAIM_PATH, usage === null ? undefined : { usage }), () => TIMED_OUT)
      if (r === TIMED_OUT) return { kind: 'failed', failure: late }
      if (r.unreachable) {
        // DX-5593 (B1): a session KNOWN to be signed in whose server cannot be reached is inside pacing and its spawn is refused (strict cap)
        if (hasSucceeded || (await env.signedIn())) return { kind: 'failed', failure: 'the danx-dashboard MCP server is not reachable from this session' }
        // not known to be signed in yet: the server may still be connecting, so it is looked for again until the claim's deadline
        if (PACING_READ_DEADLINE_MS - ((await env.now()) - startedAt) <= CONNECT_POLL_MS) {
          // DX-5593 problem 2503 (open, the operator's call): a session whose server NEVER connected within the deadline is allowed, outside pacing, as before:
          // danxbot cannot count it. Whether it should be refused instead is not decided here.
          return { kind: 'unknown' }
        }
        try {
          await env.sleep(CONNECT_POLL_MS)
        } catch {
          return { kind: 'unknown' } // the plugin was unloaded while waiting: nothing to hold
        }
        continue
      }
      // signed out: outside pacing (danxbot counts none of this session's agents, so there is no cap to hold its spawns to)
      if (isSignedOut(r)) return { kind: 'unknown' }
      if (!r.ok) return { kind: 'failed', failure: r.status === 0 ? errText(r) : `the spawn claim answered ${r.status}` }
      const claim = parseClaim(r.body)
      if (claim.kind === 'claimed' || claim.kind === 'refused') {
        cache = { pacing: claim.pacing, fetchedAt: startedAt }
        hasSucceeded = true
        lastError = null
        lastClaimError = null
      }
      return claim
    }
  } catch (err: any) {
    return { kind: 'failed', failure: String(err?.message ?? err) }
  }
}

// DX-5593 (B2): a refused spawn's toast, once per distinct text. It says the spawn was refused, never that spawns are not paced.
export function reportClaimFailure(env: PacingEnv, failure: string): void {
  failure = failure.slice(0, ERROR_MAX)
  if (failure === lastClaimError) return
  lastClaimError = failure
  env.toast(`Usage pacing could not claim a slot, so the spawn was refused (the budget is a strict cap): ${failure}`)
}

// The claim given back: the host refused the spawn after the slot was taken. Never rejects; a claim not given back lapses in danxbot within the
// minute, which stays the recovery. DX-5593 (C1): a give-back that fails is told once per distinct text (the same rule as reportClaimFailure),
// never silently: an error answer, or an unreachable server of a session known to be signed in. `{released:false}` (a 200) is normal and silent.
export async function releaseClaim(env: PacingEnv, claimId: string): Promise<void> {
  try {
    const r = await env.within<Api | undefined>(PACING_READ_DEADLINE_MS, env.call('DELETE', `/api/pacing/agents/claim?claim_id=${encodeURIComponent(claimId)}`), () => undefined)
    if (r === undefined) return
    let failure: string | null = null
    if (r.unreachable) {
      if (hasSucceeded || (await env.signedIn())) failure = 'the danx-dashboard MCP server is not reachable from this session'
    } else if (!r.ok && !isSignedOut(r)) {
      failure = r.status === 0 ? errText(r) : `the claim give-back answered ${r.status}`
    }
    if (failure === null) return
    failure = failure.slice(0, ERROR_MAX)
    if (failure === lastClaimError) return
    lastClaimError = failure
    env.toast(`Usage pacing could not give back a claimed slot (it lapses within a minute): ${failure}`)
  } catch {
    /* the claim lapses in danxbot */
  }
}

// The sub-agent's pacing line, null when danxbot has none for this session. Never rejects.
export async function pacingLine(env: PacingEnv): Promise<string | null> {
  try {
    await refreshPacing(env)
    return peekPacing(await env.now())?.line ?? null
  } catch (err: any) {
    report(env, String(err?.message ?? err))
    return null
  }
}

// `result` of the SubagentStart chain with the line appended to its additionalContext (one entry per hook).
export function withLine<R extends { additionalContext?: string[] }>(result: R, line: string | null): R {
  return line === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), line] }
}
