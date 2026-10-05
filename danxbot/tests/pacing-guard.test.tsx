// DX-4340 (PLAN-29 R-10): the usage-pacing guard on `agent.spawn`. The decision table is pure; the handler answers from the session's
// pacing cache (GET /api/pacing/line, the account placed by danxbot), and denies, downgrades or lets the spawn through. It hooks
// `agent.spawn` only: no tool call is ever held, so an agent can still commit, push and write its card.
import { describe, expect, test } from 'claude-code/testing'

import { REFUSAL_PREFIX, TIGHT_FREE_SLOTS, decideSpawn, isTight, spawnGuard, tierOf } from '../hooks/plan/pacing-guard'
import { register } from '../hooks/register'
import { PACING_EXPIRY_MS, PACING_REFRESH_MS, RESERVATION_TTL_MS, resetPacing } from '../hooks/plan/pacing-line'
import type { PacingEnv } from '../hooks/plan/pacing-line'
import type { PacingVerdict } from '../hooks/plan/pacing-line'
import { dashboard, startSession } from './plan-kit'

const RESET = '2026-10-08T12:00:00.000Z'
const v = (over: Partial<PacingVerdict> = {}): PacingVerdict => ({ level: 'on_pace', budget: null, resetsAt: RESET, runningAgents: 0, ...over })
const wire = (over: Record<string, unknown> = {}) => ({
  account: 'uuid:u1',
  level: 'on_pace',
  budget: null,
  resets_at: RESET,
  running_agents: 1,
  line: 'Pacing line.',
  reason: null,
  ...over,
})
const UNKNOWN = { account: null, level: null, budget: null, resets_at: null, running_agents: null, line: null, reason: 'no_usage_account' }

describe('decideSpawn (the decision table)', () => {
  test('no verdict allows: pacing never blocks work it cannot see', () => {
    expect(decideSpawn(null, 'opus')).toEqual({ kind: 'allow' })
  })

  test('over pace and critical deny whatever the budget, naming level, budget and reset', () => {
    for (const level of ['over_pace', 'critical'] as const) {
      const d = decideSpawn(v({ level, budget: 0 }), 'sonnet')
      expect(d.kind).toBe('deny')
      const reason = (d as { reason: string }).reason
      expect(reason).toContain(level.replace('_', ' '))
      expect(reason).toContain('budget 0')
      expect(reason).toContain(RESET)
      expect(reason).toMatch(/do not retry/i)
    }
    expect(decideSpawn(v({ level: 'over_pace', budget: null }), 'sonnet').kind).toBe('deny')
  })

  test('on pace with the account at or over its budget denies; under it, or no cap, allows', () => {
    expect(decideSpawn(v({ budget: 3, runningAgents: 3 }), 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 3, runningAgents: 5 }), 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 0, runningAgents: 0 }), 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 3, runningAgents: 1 }), 'haiku')).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: null, runningAgents: 40 }), 'opus')).toEqual({ kind: 'allow' })
  })

  test('tight (budget - running <= 1) downgrades to haiku, never upward and never an unknown model', () => {
    expect(TIGHT_FREE_SLOTS).toBe(1)
    expect(isTight(3, 2)).toBe(true)
    expect(isTight(3, 1)).toBe(false)
    expect(isTight(null, 99)).toBe(false)
    for (const model of ['opus', 'sonnet', 'claude-opus-4-8', 'fable']) {
      expect(decideSpawn(v({ budget: 3, runningAgents: 2 }), model)).toEqual({ kind: 'downgrade', model: 'haiku' })
    }
    expect(decideSpawn(v({ budget: 3, runningAgents: 2 }), 'haiku')).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 3, runningAgents: 2 }), 'mystery-model')).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 3, runningAgents: 2 }), undefined)).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 5, runningAgents: 2 }), 'opus')).toEqual({ kind: 'allow' })
  })

  test('tierOf places aliases and ids', () => {
    expect(tierOf('claude-haiku-4-5')).toBe('haiku')
    expect(tierOf('OPUS')).toBe('opus')
    expect(tierOf('gpt')).toBeNull()
  })
})

// a gate the base spawn waits on: open (the default) lets spawns start at once; `hold()` keeps them inside next() until `release()`
const gate: { promise: Promise<void>; release: () => void } = { promise: Promise.resolve(), release: () => {} }
const hold = () => {
  gate.promise = new Promise<void>(resolve => void (gate.release = resolve))
}

describe('the agent.spawn hook', () => {
  // the engine's own answer beneath the guard: a started sub-agent
  const spawn = ($: any, over: Record<string, unknown> = {}) => $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose', ...over })

  async function session($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
    resetPacing()
    gate.promise = Promise.resolve()
    gate.release = () => {}
    // the engine's own answer beneath the guard: a started sub-agent, or the host refusing (prompt 'refuse'), after the test opens `gate`
    on('agent.spawn', async (_$: any, e: any) => {
      await gate.promise
      return (e.prompt === 'refuse' ? { deny: 'host refused' } : { model: e.model ?? 'parent-model', agentId: 'new' }) as any
    })
    on('tool.call', () => ({ result: {}, text: 'ran', isError: false }) as any)
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    return d
  }

  test('denies on an over-pace verdict with the reason as the error, and starts nothing', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'over_pace', budget: 0 }) } })
    const r = await spawn($)
    expect(r.deny).toMatch(/Usage pacing: this account is over pace/)
    expect(r.deny).toContain(RESET)
  })

  test('denies when the account is at its budget, by the account count the line carries', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 2, running_agents: 2 }) } })
    expect((await spawn($)).deny).toMatch(/2 agent\(s\) already run/)
  })

  test('allows with no cap, and leaves the model alone', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: null, running_agents: 9 }) } })
    const r = await spawn($, { model: 'opus' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('opus')
  })

  test('rewrites the model down to haiku when the budget is tight, never up', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 2 }) } })
    expect((await spawn($, { model: 'opus' })).model).toBe('haiku')
  })

  test('allows when danxbot answers unknown (the line carries a reason): nothing is said', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: UNKNOWN } })
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts).toEqual([])
  })

  test('a burst of spawns is held to the budget, across a refresh too, until the reservations lapse', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 0 }) } })
    for (let i = 0; i < 3; i++) expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
    expect((await spawn($, { model: 'haiku' })).deny).toMatch(/3 agent\(s\) already run/)
    expect(d.pacingReads).toHaveLength(1)
    // a fresh read cannot tell which spawns its count includes: the reservations stand
    await d.clock.advance(PACING_REFRESH_MS + 1)
    expect((await spawn($, { model: 'haiku' })).deny).toBeDefined()
    expect(d.pacingReads).toHaveLength(2)
    // after the TTL the live count is the truth
    await d.clock.advance(RESERVATION_TTL_MS)
    expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
  })

  test('a reservation survives a cache refresh: budget 1, spawn A still starting, a minute on, spawn B is denied', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 1, running_agents: 0 }) } })
    hold()
    const a = spawn($, { model: 'haiku' })
    await d.clock.advance(PACING_REFRESH_MS + 1)
    expect((await spawn($, { model: 'haiku' })).deny).toMatch(/already run/)
    expect(d.pacingReads).toHaveLength(2)
    gate.release()
    expect((await a).deny).toBeUndefined()
  })

  test('a host-refused spawn gives back only its own slot, never another spawn\'s, even after its own lapsed', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 2, running_agents: 0 }) } })
    hold()
    const refused = spawn($, { prompt: 'refuse', model: 'haiku' })
    await d.clock.advance(2 * 60_000)
    const kept = spawn($, { model: 'haiku' })
    // the first reservation has lapsed by now; the second is live
    await d.clock.advance(RESERVATION_TTL_MS - 2 * 60_000 + 30_000)
    gate.release()
    expect((await refused).deny).toBe('host refused')
    expect((await kept).deny).toBeUndefined()
    // the second spawn's reservation is intact: one slot of two is taken, so one more fits and then it is full
    expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
    expect((await spawn($, { model: 'haiku' })).deny).toMatch(/already run/)
  })

  test('parallel spawns are held to the budget exactly: 6 at once against a budget of 3 let 3 through', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 0 }) } })
    const results = await Promise.all(Array.from({ length: 6 }, () => spawn($, { model: 'haiku' })))
    expect(results.filter(r => r.deny === undefined)).toHaveLength(3)
    expect(results.filter(r => r.deny !== undefined)).toHaveLength(3)
    expect(d.pacingReads).toHaveLength(1)
  })

  test('a fork is denied like any spawn', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    expect((await spawn($, { fork: true })).deny).toMatch(/critical/)
  })

  test('a tight fork is let through with its model untouched: a fork ignores the model', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 2 }) } })
    expect((await spawn($, { fork: true, model: 'opus' })).model).toBe('opus')
  })

  test('a cache older than 30 minutes is not trusted: the spawn is allowed', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = await session($, on, options)
    expect((await spawn($)).deny).toBeDefined()
    options.pacingLine = { status: 500 }
    await d.clock.advance(PACING_EXPIRY_MS + 1)
    expect((await spawn($)).deny).toBeUndefined()
  })

  test('a failed read keeps the last good answer serving, backs off for a minute, and toasts once', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = await session($, on, options)
    options.pacingLine = { status: 500 }
    await d.clock.advance(PACING_REFRESH_MS + 1)
    expect((await spawn($)).deny).toMatch(/critical/)
    expect(d.pacingReads).toHaveLength(2)
    // the dead route is not hit again by each spawn inside the back-off
    await spawn($)
    await spawn($)
    expect(d.pacingReads).toHaveLength(2)
    await d.clock.advance(PACING_REFRESH_MS + 1)
    await spawn($)
    expect(d.pacingReads).toHaveLength(3)
    expect(d.toasts.filter(t => t.startsWith('Usage pacing could not be read'))).toHaveLength(1)
  })

  test('unreachable at session start is silent and not backed off: the next spawn looks again', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { mcp: 'down' }
    const d = await session($, on, options)
    expect((await spawn($)).deny).toBeUndefined()
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toEqual([])
    // no wait between: every look is an attempt, and the server coming up is seen at once
    expect(d.pacingAttempts.n).toBe(3)
    options.mcp = 'up'
    options.pacingLine = { body: wire({ level: 'critical', budget: 0 }) }
    expect((await spawn($)).deny).toMatch(/critical/)
  })

  test('unreachable AFTER a successful read is a failure like any other: toasted once, backed off, last good answer kept', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = await session($, on, options)
    options.mcp = 'down'
    await d.clock.advance(PACING_REFRESH_MS + 1)
    expect((await spawn($)).deny).toMatch(/critical/)
    await spawn($)
    expect(d.toasts.filter(t => t.startsWith('Usage pacing could not be read') && t.includes('not reachable'))).toHaveLength(1)
  })

  test('a 404 is a failure like any other: toasted, not a quiet unknown', async ($, on) => {
    const d = await session($, on, { pacingLine: { status: 404 } })
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts.filter(t => t.includes('answered 404'))).toHaveLength(1)
  })

  test('reads the line at session start, then once a minute, and again after it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire() } })
    expect(d.pacingReads).toHaveLength(1)
    await spawn($)
    await spawn($)
    expect(d.pacingReads).toHaveLength(1)
    await d.clock.advance(PACING_REFRESH_MS + 1)
    await spawn($)
    expect(d.pacingReads).toHaveLength(2)
  })

  test('a tool call of any tool is never denied under a critical verdict: saving work stays possible', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    for (const tool of ['Bash', 'Write', 'mcp__danx-dashboard__danxbot_api']) {
      const r = await $.tool.call({ tool, command: 'git commit -m x' } as any)
      expect(r.deny).toBeUndefined()
      expect(r.isError).not.toBe(true)
      expect(r.text).toBe('ran')
    }
  })
})

describe('failures of the guard itself', () => {
  test('a hook error (a rejecting clock) is told once per text, never a toast per spawn, and the spawn goes on', async () => {
    resetPacing()
    const toasts: string[] = []
    const env: PacingEnv = { now: () => Promise.reject(new Error('clock down')), call: () => Promise.reject(new Error('never reached')), toast: t => void toasts.push(t) }
    const started = { model: 'm', agentId: 'a' }
    const guard = spawnGuard(env)
    const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
    expect(await guard(e, async () => started)).toBe(started)
    expect(await guard(e, async () => started)).toBe(started)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('clock down')
  })

  test('a refusal starts with the prefix the skill quotes', () => {
    expect((decideSpawn(v({ level: 'critical', budget: 0 }), 'opus') as { reason: string }).reason.startsWith(REFUSAL_PREFIX)).toBe(true)
    expect(REFUSAL_PREFIX).toBe('Usage pacing:')
  })
})

describe('a second session in the same process', () => {
  test('never inherits the previous session\'s last good answer, state or reservations', async ($, on) => {
    resetPacing()
    on('agent.spawn', (_$: any, e: any) => ({ model: e.model ?? 'm', agentId: 'new' }) as any)
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    expect((await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose' })).deny).toMatch(/critical/)
    // the next session's read fails: it must not be paced by the last session's critical answer
    options.pacingLine = { status: 500 }
    await startSession($, d, 'desktop')
    expect((await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose' })).deny).toBeUndefined()
  })
})

describe('what register wires', () => {
  test('agent.spawn carries the pacing guard, and no tool.call handler can carry it', () => {
    const wired: { event: string; matcher: unknown }[] = []
    register(((event: string, ...rest: unknown[]) => void wired.push({ event, matcher: rest.length > 1 ? rest[0] : undefined })) as any, {} as any)
    expect(wired.filter(w => w.event === 'agent.spawn')).toHaveLength(1)
    // every tool.call hook is matched to one danx-dashboard tool: none is a catch-all, so none can sit on a commit, push or card write
    const toolCalls = wired.filter(w => w.event === 'tool.call')
    expect(toolCalls.length).toBeGreaterThan(0)
    for (const w of toolCalls) expect((w.matcher as { tool?: string })?.tool).toMatch(/^mcp__(plugin_danxbot_)?danx-dashboard__(plan_connect|request_permission)$/)
  })
})
