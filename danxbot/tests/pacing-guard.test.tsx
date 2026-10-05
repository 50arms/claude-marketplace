// DX-4340 (PLAN-29 R-10): the usage-pacing guard on `agent.spawn`. The decision table is pure; the handler reads danxbot's verdict
// (GET /api/pacing/verdicts, cached a minute), picks this session's account, and denies, downgrades or lets the spawn through. It hooks
// `agent.spawn` only: no tool call is ever held, so an agent can still commit, push and write its card.
import { describe, expect, test } from 'claude-code/testing'

import { VERDICT_REFRESH_MS, VERDICTS_PATH, decideSpawn, isTight, minuteKey, parseVerdicts, pickVerdict, resetPacingCache, tierOf } from '../hooks/plan/pacing-guard'
import type { PacingVerdict } from '../hooks/plan/pacing-guard'
import { dashboard, startSession } from './plan-kit'

const RESET = '2026-10-03T11:10:00.000Z'
const WEEK = '2026-10-09T09:00:00.000Z'
const v = (over: Partial<PacingVerdict> = {}): PacingVerdict => ({ account: 'a', level: 'on_pace', budget: null, resetsAt: RESET, activeAgents: 0, ...over })
const row = (over: Record<string, unknown> = {}) => ({
  account: `weekly:${WEEK}`,
  level: 'on_pace',
  budget: null,
  binding_limit: 'five_hour',
  running_agents: 1,
  limits: [{ limit: 'five_hour', resets_at: RESET }, { limit: 'weekly', resets_at: WEEK }],
  ...over,
})

describe('decideSpawn (the decision table)', () => {
  test('no verdict allows: pacing never blocks work it cannot see', () => {
    expect(decideSpawn(null, 9, 'opus')).toEqual({ kind: 'allow' })
  })

  test('over pace and critical deny whatever the budget, naming level, budget and reset', () => {
    for (const level of ['over_pace', 'critical'] as const) {
      const d = decideSpawn(v({ level, budget: 0 }), 0, 'sonnet')
      expect(d.kind).toBe('deny')
      const reason = (d as { reason: string }).reason
      expect(reason).toContain(level.replace('_', ' '))
      expect(reason).toContain('budget 0')
      expect(reason).toContain(RESET)
      expect(reason).toMatch(/do not retry/i)
    }
    expect(decideSpawn(v({ level: 'over_pace', budget: null }), 0, 'sonnet').kind).toBe('deny')
  })

  test('on pace with a count at or over the budget denies; under it, or no cap, allows', () => {
    expect(decideSpawn(v({ budget: 3, activeAgents: 3 }), 0, 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 3, activeAgents: 5 }), 0, 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 0, activeAgents: 0 }), 0, 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 3, activeAgents: 1 }), 0, 'haiku')).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: null, activeAgents: 40 }), 40, 'opus')).toEqual({ kind: 'allow' })
  })

  test('the account count comes from the verdict; the local count stands in only when the verdict has none', () => {
    expect(decideSpawn(v({ budget: 3, activeAgents: 1 }), 9, 'haiku').kind).toBe('allow')
    expect(decideSpawn(v({ budget: 3, activeAgents: null }), 3, 'haiku').kind).toBe('deny')
    expect(decideSpawn(v({ budget: 3, activeAgents: null }), 1, 'haiku').kind).toBe('allow')
  })

  test('tight (budget - running <= 1) downgrades to haiku, never upward and never an unknown model', () => {
    expect(isTight(3, 2)).toBe(true)
    expect(isTight(3, 1)).toBe(false)
    expect(isTight(null, 99)).toBe(false)
    for (const model of ['opus', 'sonnet', 'claude-opus-4-8', 'fable']) {
      expect(decideSpawn(v({ budget: 3, activeAgents: 2 }), 0, model)).toEqual({ kind: 'downgrade', model: 'haiku' })
    }
    expect(decideSpawn(v({ budget: 3, activeAgents: 2 }), 0, 'haiku')).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 3, activeAgents: 2 }), 0, 'mystery-model')).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 3, activeAgents: 2 }), 0, undefined)).toEqual({ kind: 'allow' })
    expect(decideSpawn(v({ budget: 5, activeAgents: 2 }), 0, 'opus')).toEqual({ kind: 'allow' })
  })

  test('tierOf places aliases and ids', () => {
    expect(tierOf('claude-haiku-4-5')).toBe('haiku')
    expect(tierOf('OPUS')).toBe('opus')
    expect(tierOf('gpt')).toBeNull()
  })
})

describe('parseVerdicts and pickVerdict', () => {
  test('reads level, budget, the deciding limit\'s reset and the account count', () => {
    expect(parseVerdicts({ verdicts: [row({ budget: 2, running_agents: 4 })] })).toEqual([
      { account: `weekly:${WEEK}`, level: 'on_pace', budget: 2, resetsAt: RESET, activeAgents: 4 },
    ])
    expect(parseVerdicts({ verdicts: [] })).toEqual([])
  })

  test('a row it cannot read is an error, never a guessed verdict', () => {
    expect(typeof parseVerdicts({})).toBe('string')
    expect(typeof parseVerdicts({ verdicts: [row({ level: 'fine' })] })).toBe('string')
    expect(typeof parseVerdicts({ verdicts: [row({ budget: -1 })] })).toBe('string')
    expect(typeof parseVerdicts({ verdicts: [{}] })).toBe('string')
  })

  test('matches the session\'s account by uuid, then weekly reset minute; else the tightest verdict', () => {
    const verdicts = [
      v({ account: 'uuid:u1', level: 'on_pace', budget: 4 }),
      v({ account: `weekly:${minuteKey(WEEK)}`, level: 'over_pace', budget: 0 }),
      v({ account: 'override:x', level: 'on_pace', budget: 1 }),
    ]
    expect(pickVerdict(verdicts, { accountUuid: 'u1', weeklyResetsAt: WEEK })?.account).toBe('uuid:u1')
    expect(pickVerdict(verdicts, { weeklyResetsAt: '2026-10-09T09:00:20.000Z' })?.account).toBe(`weekly:${minuteKey(WEEK)}`)
    expect(pickVerdict(verdicts, {})?.level).toBe('over_pace')
    expect(pickVerdict([], {})).toBeNull()
  })

  test('with equal levels the smaller budget is the tightest, and no cap is the loosest', () => {
    expect(pickVerdict([v({ account: 'p', budget: null }), v({ account: 'q', budget: 2 }), v({ account: 'r', budget: 5 })], {})?.account).toBe('q')
  })
})

describe('the agent.spawn hook', () => {
  // the engine's own answer beneath the guard: a started sub-agent
  const spawn = ($: any, over: Record<string, unknown> = {}) => $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose', ...over })

  async function session($: any, on: any, options: Parameters<typeof dashboard>[1] = {}, running = 0) {
    resetPacingCache()
    on('agent.spawn', (_$: any, e: any) => ({ model: e.model ?? 'parent-model', agentId: 'new' }) as any)
    const d = dashboard(on, options)
    d.world.agents = Array.from({ length: running }, (_, i) => ({ id: `r${i}`, type: 'general-purpose', description: 'd', status: 'running' }))
    await startSession($, d, 'desktop')
    return d
  }

  test('denies on an over-pace verdict with the reason as the error, and starts nothing', async ($, on) => {
    await session($, on, { pacing: { body: { verdicts: [row({ level: 'over_pace', budget: 0 })] } } })
    const r = await spawn($)
    expect(r.deny).toMatch(/Usage pacing: this account is over pace/)
    expect(r.deny).toContain(RESET)
  })

  test('denies when the account is at its budget, by the verdict\'s count', async ($, on) => {
    await session($, on, { pacing: { body: { verdicts: [row({ budget: 2, running_agents: 2 })] } } })
    expect((await spawn($)).deny).toMatch(/2 agent\(s\) already run/)
  })

  test('allows with no cap even when sub-agents are running, and leaves the model alone', async ($, on) => {
    await session($, on, { pacing: { body: { verdicts: [row({ budget: null })] } } }, 3)
    const r = await spawn($, { model: 'opus' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('opus')
  })

  test('rewrites the model down to haiku when the budget is tight, never up', async ($, on) => {
    await session($, on, { pacing: { body: { verdicts: [row({ budget: 3, running_agents: 2 })] } } })
    expect((await spawn($, { model: 'opus' })).model).toBe('haiku')
    expect((await spawn($, { model: 'haiku' })).model).toBe('haiku')
  })

  test('allows when pacing is off for the team (no verdicts)', async ($, on) => {
    const d = await session($, on, { pacing: { body: { verdicts: [] } } })
    const r = await spawn($)
    expect(r.deny).toBeUndefined()
    expect(d.toasts).toEqual([])
  })

  test('allows and says so once when the verdict cannot be read', async ($, on) => {
    const d = await session($, on, { pacing: { status: 500 } })
    expect((await spawn($)).deny).toBeUndefined()
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts.filter(t => t.startsWith('Usage pacing could not read'))).toHaveLength(1)
  })

  test('reads the verdict once a minute, and again after it', async ($, on) => {
    const d = await session($, on, { pacing: { body: { verdicts: [row()] } } })
    const reads = () => d.api.filter(a => a.path === VERDICTS_PATH).length
    await spawn($)
    await spawn($)
    expect(reads()).toBe(1)
    await d.clock.advance(VERDICT_REFRESH_MS + 1)
    await spawn($)
    expect(reads()).toBe(2)
  })
})
