// DX-4340 (PLAN-29 section 3): the ONE pacing cache. danxbot serves the calling session's own account's verdict, and the one-sentence line
// a new sub-agent is handed, at GET /api/pacing/line (the account is placed server-side from the x-danx-session-id header the dashboard
// MCP sends; src/team-pacing/session-pacing.ts). Both consumers read this cache: the `agent.spawn` guard (pacing-guard.ts) and the
// SubagentStart pacing line (register.tsx). No account matching happens in the plugin.
//
// Unknown is explicit on the wire (`reason` set, every other field null: no session, no usage report, no verdict, pacing off) and means
// the guard allows and no line is handed. A read that fails is never silent (one toast per distinct text) and keeps the last good answer
// until it expires.

export type PacingLevel = 'on_pace' | 'over_pace' | 'critical'
const LEVELS: readonly PacingLevel[] = ['on_pace', 'over_pace', 'critical']

// The verdict as the guard reads it. `budget`: null = no cap, 0 = start nothing new, n = most agents running at once across the whole
// account; `runningAgents` is the account's running agents when danxbot computed it.
export type PacingVerdict = { level: PacingLevel; budget: number | null; resetsAt: string | null; runningAgents: number }
export type Pacing = { verdict: PacingVerdict; line: string }

export type Call = (method: string, path: string) => Promise<{ ok: boolean; status: number; body: any; unreachable?: boolean }>
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

// `pacing` null = danxbot answered unknown. A module-state cache: a reload starts it over and the next read refetches.
type Cache = { pacing: Pacing | null; fetchedAt: number }
let cache: Cache | null = null
let lastError: string | null = null
let inflight: Promise<void> | null = null

export function resetPacingCache(): void {
  cache = null
  lastError = null
  inflight = null
}

async function fetchPacing(env: PacingEnv): Promise<void> {
  let failure: string | null = null
  try {
    const r = await env.call('GET', LINE_PATH)
    // another repo's session has no danxbot dashboard: nothing to pace against, nothing to complain about
    if (r.unreachable) return
    // a dashboard that predates the route (DX-4340) has nothing to pace against: unknown, as for another repo's session
    if (r.status === 404) cache = { pacing: null, fetchedAt: await env.now() }
    else if (!r.ok) failure = `the pacing line read answered ${r.status}`
    else {
      const parsed = parsePacing(r.body)
      if (parsed !== null && 'error' in parsed) failure = parsed.error
      else cache = { pacing: parsed, fetchedAt: await env.now() }
    }
  } catch (err: any) {
    failure = String(err?.message ?? err)
  }
  failure = failure === null ? null : failure.slice(0, ERROR_MAX)
  if (failure === lastError) return
  lastError = failure
  if (failure !== null) env.toast(`Usage pacing could not be read (spawns are not paced, sub-agents get no pacing line, until it can): ${failure}`)
}

// Refetch now when `force`, else when the cache is a minute old; concurrent callers share one read.
export async function refreshPacing(env: PacingEnv, force = false): Promise<void> {
  const now = await env.now()
  if (!force && cache !== null && now - cache.fetchedAt < PACING_REFRESH_MS) return
  inflight ??= fetchPacing(env).finally(() => void (inflight = null))
  await inflight
}

// The session's pacing (null when unknown or expired), refreshed when stale. Never throws on a failed read.
export async function currentPacing(env: PacingEnv): Promise<Pacing | null> {
  await refreshPacing(env)
  return cache !== null && (await env.now()) - cache.fetchedAt <= PACING_EXPIRY_MS ? cache.pacing : null
}

// The sub-agent's pacing line, null when danxbot has none for this session.
export async function pacingLine(env: PacingEnv): Promise<string | null> {
  return (await currentPacing(env))?.line ?? null
}

// `result` of the SubagentStart chain with the line appended to its additionalContext (one entry per hook).
export function withLine<R extends { additionalContext?: string[] }>(result: R, line: string | null): R {
  return line === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), line] }
}
