// DX-4340 (PLAN-29 R-10): the usage-pacing guard on `agent.spawn`. The decision table is pure; the handler answers from the session's
// pacing cache (GET /api/pacing/line, the account placed by danxbot), and denies, downgrades or lets the spawn through. It hooks
// `agent.spawn` only: no tool call is ever held, so an agent can still commit, push and write its card.
import { describe, expect, test } from 'claude-code/testing'

import { decideSpawn, isTight, tierOf } from '../hooks/plan/pacing-guard'
import { PACING_REFRESH_MS, resetPacingCache } from '../hooks/plan/pacing-line'
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

describe('the agent.spawn hook', () => {
  // the engine's own answer beneath the guard: a started sub-agent
  const spawn = ($: any, over: Record<string, unknown> = {}) => $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose', ...over })

  async function session($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
    resetPacingCache()
    on('agent.spawn', (_$: any, e: any) => ({ model: e.model ?? 'parent-model', agentId: 'new' }) as any)
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
    expect((await spawn($, { model: 'haiku' })).model).toBe('haiku')
  })

  test('allows when danxbot answers unknown (the line carries a reason): nothing is said', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: UNKNOWN } })
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts).toEqual([])
  })

  test('allows and says so once when the line cannot be read', async ($, on) => {
    const d = await session($, on, { pacingLine: { status: 500 } })
    expect((await spawn($)).deny).toBeUndefined()
    await d.clock.advance(PACING_REFRESH_MS + 1)
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts.filter(t => t.startsWith('Usage pacing could not be read'))).toHaveLength(1)
  })

  test('reads the line at session start, then once a minute, and again after it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire() } })
    const reads = () => d.pacingReads.length
    expect(reads()).toBe(1)
    await spawn($)
    await spawn($)
    expect(reads()).toBe(1)
    await d.clock.advance(PACING_REFRESH_MS + 1)
    await spawn($)
    expect(reads()).toBe(2)
  })

  test('never reads the verdict list or matches accounts: only the line route is called', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire() } })
    await spawn($)
    expect(d.api.filter(a => a.path.startsWith('/api/pacing'))).toEqual([])
    expect(d.pacingReads.length).toBeGreaterThan(0)
  })
})
