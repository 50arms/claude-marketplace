import type { Api } from './load'

// DX-4340 (PLAN-29 section 3): the ONE pacing cache. danxbot serves the calling session's own account's verdict, and the one-sentence line
// a new sub-agent is handed, at GET /api/pacing/line (the account is placed server-side from the x-danx-session-id header the dashboard
// MCP sends; src/team-pacing/session-pacing.ts). Both consumers read this cache: the `agent.spawn` guard (pacing-guard.ts) and the
// SubagentStart pacing line (register.tsx). No account matching happens in the plugin.
//
// Unknown is explicit on the wire (`reason` set, every other field null: no session, no usage report, no verdict, pacing off) and means
// the guard allows and no line is handed.
//
// A failed read is never silent: one toast per distinct text. It keeps the last good answer serving until it expires, and it is not
// retried for PACING_REFRESH_MS, so each spawn or sub-agent start does not re-hit a dead route. The one exception is an unreachable
// danx-dashboard MCP server (a session on a repo with no danxbot, as in reportUsage and DX-3421): that is silent and not backed off,
// the next spawn simply looks again, until a read has succeeded in this session. After a success it is a failure like any other.

import type { PacingLevel, PacingVerdict } from '../../types'

const LEVELS: readonly PacingLevel[] = ['on_pace', 'over_pace', 'critical']

// The verdict as the guard reads it (`PacingVerdict`, types/index.d.ts, shared with the plan panel) and danxbot's one-sentence line.
export type Pacing = { verdict: PacingVerdict; line: string }

export type Call = (method: string, path: string) => Promise<Api>
// The engine calls pacing makes, as closures built in register.tsx (the engine follows `$` only into a function in that file).
export type PacingEnv = { now: () => Promise<number>; call: Call; toast: (text: string) => void }

export const LINE_PATH = '/api/pacing/line'
// danxbot changes the verdict only at its 10-minute tick; the plugin cannot hear `pacing-verdicts:updated` (a hooks module has no
// dashboard event source), so the cache is refreshed when it is a minute old, and on session start (`refreshPacing`).
export const PACING_REFRESH_MS = 60_000
export const PACING_EXPIRY_MS = 30 * 60_000
const ERROR_MAX = 200

// `body` of GET /api/pacing/line: a known answer, null for the explicit unknown, an error for anything else.
export function parsePacing(body: any): Pacing | null | { error: string } {
  if (body === null || typeof body !== 'object') return { error: 'the pacing line answer is not an object' }
  if (body.level === null && body.line === null) return typeof body.reason === 'string' ? null : { error: 'the pacing line answer has no verdict and no reason' }
  if (!LEVELS.includes(body.level)) return { error: 'the pacing line answer has no valid level' }
  if (body.budget !== null && !(Number.isInteger(body.budget) && body.budget >= 0)) return { error: 'the pacing line answer has no valid budget' }
  if (!Number.isInteger(body.running_agents) || body.running_agents < 0) return { error: 'the pacing line answer has no running_agents' }
  if (typeof body.line !== 'string' || body.line.trim() === '') return { error: 'the pacing line answer has no readable line' }
  return {
    verdict: { level: body.level, budget: body.budget, resetsAt: typeof body.resets_at === 'string' ? body.resets_at : null, runningAgents: body.running_agents },
    line: body.line,
  }
}

// `pacing` null = danxbot answered unknown. `allowed` is the spawns the guard let through since this read: danxbot's running count is as of
// the read, so a burst of spawns inside one turn is held to the budget by adding them (recordSpawn), and a fresh read resets it (its count
// is live and already includes them). A module-state cache: a reload starts it over and the next read refetches.
type Cache = { pacing: Pacing | null; fetchedAt: number; allowed: number }
let cache: Cache | null = null
// when the last read was ATTEMPTED and the server was reachable (success or failure): the back-off clock
let lastReadAt: number | null = null
// a read has succeeded in this session: from then on an unreachable server is worth a toast
let hasSucceeded = false
let lastError: string | null = null
let inflight: Promise<void> | null = null

export function resetPacingCache(): void {
  cache = null
  lastReadAt = null
  hasSucceeded = false
  lastError = null
  inflight = null
}

// One toast per distinct failure text.
function report(env: PacingEnv, failure: string): void {
  failure = failure.slice(0, ERROR_MAX)
  if (failure === lastError) return
  lastError = failure
  env.toast(`Usage pacing could not be read (spawns are not paced, sub-agents get no pacing line, until it can): ${failure}`)
}

async function fetchPacing(env: PacingEnv): Promise<void> {
  try {
    const at = await env.now()
    const r = await env.call('GET', LINE_PATH)
    if (r.unreachable) {
      // silent and not backed off until a read has succeeded (see the header)
      if (hasSucceeded) report(env, 'the danx-dashboard MCP server is not reachable from this session')
      return
    }
    lastReadAt = at
    if (!r.ok) return report(env, `the pacing line read answered ${r.status}`)
    const parsed = parsePacing(r.body)
    if (parsed !== null && 'error' in parsed) return report(env, parsed.error)
    cache = { pacing: parsed, fetchedAt: at, allowed: 0 }
    hasSucceeded = true
    // a good read clears the failure, so the same failure is told again if it comes back
    lastError = null
  } catch (err: any) {
    report(env, String(err?.message ?? err))
  }
}

// Read now when `force`, else when the last reachable read attempt is a minute old; concurrent callers share one read. Never rejects: a
// clock that fails is a failed read like any other.
export async function refreshPacing(env: PacingEnv, force = false): Promise<void> {
  try {
    const now = await env.now()
    if (!force && lastReadAt !== null && now - lastReadAt < PACING_REFRESH_MS) return
    inflight ??= fetchPacing(env).finally(() => void (inflight = null))
    await inflight
  } catch (err: any) {
    report(env, String(err?.message ?? err))
  }
}

// SYNCHRONOUS: the session's pacing at `nowMs` (null when unknown or expired), its running count raised by the spawns allowed since the
// read. A failed read leaves the last good answer serving until it expires. No await: a caller that reads this and then calls
// recordSpawn with no await between them reserves atomically, whatever the host's concurrency.
export function peekPacing(nowMs: number): Pacing | null {
  if (cache === null || cache.pacing === null || nowMs - cache.fetchedAt > PACING_EXPIRY_MS) return null
  return { ...cache.pacing, verdict: { ...cache.pacing.verdict, runningAgents: cache.pacing.verdict.runningAgents + cache.allowed } }
}

// A spawn the guard let through (+1) or one that did not start after all (-1): counted until the next fresh read.
export function recordSpawn(delta: 1 | -1): void {
  if (cache !== null) cache.allowed = Math.max(0, cache.allowed + delta)
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
