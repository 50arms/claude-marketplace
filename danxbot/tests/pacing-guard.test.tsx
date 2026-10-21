import "./run-tests-with-npm-test.generated"
// DX-4340 (PLAN-29 R-10): the usage-pacing guard on `agent.spawn`. The decision table is pure; the handler answers from the session's
// pacing cache (GET /api/pacing/line, the account placed by danxbot), and denies, downgrades or lets the spawn through. It hooks
// `agent.spawn` only: no tool call is ever held, so an agent can still commit, push and write its card.
import { describe, expect } from 'claude-code/testing'

import { REFUSAL_PREFIX, TIGHT_FREE_SLOTS, decideSpawn, isTight, spawnGuard, tierOf } from '../hooks/plan/pacing-guard'
import { register } from '../hooks/register'
import { PACING_READ_DEADLINE_MS, PACING_REFRESH_MS, releaseClaim, resetPacing } from '../hooks/plan/pacing-line'
import type { PacingEnv } from '../hooks/plan/pacing-line'
import type { PacingVerdict } from '../types'
import { BLOCKED_LINE } from '../hooks/plan/config'
import { test, dashboard, startSession } from './plan-kit'

const RESET = '2026-10-08T12:00:00.000Z'
const v = (over: Partial<PacingVerdict> = {}): PacingVerdict => ({ level: 'on_pace', budget: null, resetsAt: RESET, runningAgents: 0, ...over })
const wire = (over: Record<string, unknown> = {}) => ({
  account: 'uuid:u1',
  level: 'on_pace',
  budget: null,
  resets_at: RESET,
  running_agents: 1,
  line: 'Pacing line.',
  spend: null,
  limits: [{ limit: 'five_hour', level: 'on_pace', state: 'spare', headroom_minutes: 60, resets_in_minutes: 100, used_percent: 3, target_percent: 95, critical_percent: 99, resets_at: RESET }],
  worst_limit: 'five_hour',
  reason: null,
  ...over,
})
const UNKNOWN = { account: null, level: null, budget: null, resets_at: null, running_agents: null, line: null, spend: null, limits: null, worst_limit: null, reason: 'no_usage_account' }

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

describe('the agent.spawn hook', () => {
  // what the cache holds, as a new sub-agent sees it: the line of the last answer, as an UNFORCED read serves it inside the minute after any read
  const subagentLine = async ($: any, d: any): Promise<string | null> => {
    const r = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' } as any)
    // DX-4686: the start's live check is detached from the hook; let it end before the test does
    await d.clock.settle()
    return (r.additionalContext ?? []).find((t: string) => t === 'Pacing line.') ?? null
  }
  // the engine's own answer beneath the guard: a started sub-agent
  const spawn = ($: any, over: Record<string, unknown> = {}) => $.agent.spawn({ prompt: 'work', subagentType: 'general-purpose', ...over })

  async function session($: any, on: any, options: Parameters<typeof dashboard>[1] = {}) {
    resetPacing()
    // the engine's own answer beneath the guard: a started sub-agent, or the host refusing (prompt 'refuse')
    // (prompt 'refuse-and-drop': the host refuses and the danx-dashboard server drops before the claim is given back)
    on('agent.spawn', async (_$: any, e: any) => {
      if (e.prompt === 'refuse-and-drop') options.mcp = 'down'
      return (e.prompt === 'refuse' || e.prompt === 'refuse-and-drop' ? { deny: 'host refused' } : { model: e.model ?? 'parent-model', agentId: 'new' }) as any
    })
    on('tool.call', () => ({ result: {}, text: 'ran', isError: false }) as any)
    on('classic.SubagentStart', () => ({}) as any)
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    return d
  }
  // the toasts about pacing since `from` (a session start that reads a failing line toasts its own failure first)
  const claimToasts = (d: any, from = 0) => d.toasts.slice(from).filter((t: string) => t.startsWith('Usage pacing could not claim a slot'))
  const giveBackToasts = (d: any) => d.toasts.filter((t: string) => t.startsWith('Usage pacing could not give back a claimed slot'))

  test('denies on an over-pace verdict with the reason as the error, and starts nothing', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ level: 'over_pace', budget: 0 }) } })
    const r = await spawn($)
    expect(r.deny).toMatch(/Usage pacing: this account is over pace/)
    expect(r.deny).toContain(RESET)
    expect(d.claimsAllowed).toEqual([])
  })

  test('denies when the account is at its budget, by the live account count the claim carries', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 2, running_agents: 2 }) } })
    expect((await spawn($)).deny).toMatch(/2 agent\(s\) already run/)
  })

  test('allows with no cap, and leaves the model alone', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: null, running_agents: 9 }) } })
    const r = await spawn($, { model: 'opus' })
    expect(r.deny).toBeUndefined()
    expect(r.model).toBe('opus')
    expect(d.claimsAllowed).toHaveLength(1)
  })

  test('rewrites the model down to haiku when the budget is tight, never up', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 2 }) } })
    expect((await spawn($, { model: 'opus' })).model).toBe('haiku')
  })

  test('allows when danxbot answers unknown (the claim carries a reason): nothing is claimed, nothing is said', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: UNKNOWN } })
    expect((await spawn($)).deny).toBeUndefined()
    expect(d.toasts).toEqual([])
    expect(d.claimsAllowed).toEqual([])
  })

  // DX-5593 (N2): the first usage report is fire-and-forget, so the claim carries the session's latest reading and danxbot places the session on its account itself
  test("the claim carries the session's latest usage reading, the body the usage report sends", async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 5, running_agents: 1 }) } })
    d.world.rateLimits = [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-20T20:00:00.000Z' }, { kind: 'seven_day', percentUsed: 10, resetsAt: '2026-10-25T00:00:00.000Z' }]
    await spawn($)
    const sent = d.claimBodies.at(-1)
    expect(Object.keys(sent)).toEqual(['usage'])
    expect(sent.usage).toMatchObject({ fiveHour: { percentUsed: 42, resetsAt: '2026-10-20T20:00:00.000Z' }, sevenDay: { percentUsed: 10, resetsAt: '2026-10-25T00:00:00.000Z' } })
    expect(Date.parse(sent.usage.measuredAt)).toBeLessThanOrEqual(Date.parse(sent.usage.reportedAt))
  })

  test('a session with no reading to give claims without one', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 5, running_agents: 1 }) } })
    d.world.rateLimits = []
    await spawn($)
    expect(d.claimBodies.at(-1)).toBeUndefined()
    expect(d.claimsAllowed).toHaveLength(1)
  })

  // DX-5593: the budget is a STRICT cap and the one count lives in danxbot: the plugin keeps no reservation. The cap itself is danxbot's (the fake dashboard
  // stands in for its answer), so what is asserted here is what the PLUGIN does with each answer: it asks danxbot every time and starts exactly the spawns it was given a claim for.
  const started = (results: { agentId?: string }[]) => results.filter(r => r.agentId !== undefined)

  test("every spawn asks danxbot for its slot, however long after the last, and starts exactly the spawns it was given a claim for", async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 0 }) } })
    const first: any[] = []
    for (let i = 0; i < 3; i++) first.push(await spawn($, { model: 'haiku' }))
    expect(started(first)).toHaveLength(3)
    expect(d.claimsAllowed).toEqual(['claim-1', 'claim-2', 'claim-3'])
    const refused = await spawn($, { model: 'haiku' })
    expect(refused.deny).toMatch(/3 agent\(s\) already run/)
    expect(started([refused])).toHaveLength(0)
    // nothing lapses or is remembered in the plugin: a minute and an hour on, the next spawn asks danxbot again and is told the same
    await d.clock.advance(PACING_REFRESH_MS + 1)
    const later = await spawn($, { model: 'haiku' })
    await d.clock.advance(60 * 60_000)
    const muchLater = await spawn($, { model: 'haiku' })
    expect([later.deny, muchLater.deny].every(deny => /already run/.test(deny ?? ''))).toBe(true)
    expect(started([later, muchLater])).toHaveLength(0)
    expect(d.claimAttempts.n).toBe(6)
    expect(d.claimsAllowed).toHaveLength(3)
  })

  test('a host-refused spawn gives its own claim back, and only its own', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 2, running_agents: 0 }) } })
    expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
    expect((await spawn($, { prompt: 'refuse', model: 'haiku' })).deny).toBe('host refused')
    expect(d.claimsReleased).toEqual(['claim-2'])
    expect([...d.heldClaims]).toEqual(['claim-1'])
    // the slot the refused spawn gave back is free again: one more fits, and then it is full
    expect((await spawn($, { model: 'haiku' })).deny).toBeUndefined()
    expect((await spawn($, { model: 'haiku' })).deny).toMatch(/already run/)
  })

  test("parallel spawns each make their own claim, and exactly the ones danxbot allowed start", async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 0 }) } })
    const results = await Promise.all(Array.from({ length: 6 }, () => spawn($, { model: 'haiku' })))
    expect(d.claimAttempts.n).toBe(6)
    // whichever claims danxbot allowed (its count decides which), the plugin started those spawns and refused the others with the budget's reason
    expect(d.claimsAllowed.length).toBeGreaterThan(0)
    expect(started(results)).toHaveLength(d.claimsAllowed.length)
    for (const r of results.filter(r => r.agentId === undefined)) expect(r.deny).toMatch(/already run/)
    expect(d.claimsReleased).toEqual([])
  })

  test('a fork is denied like any spawn', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    expect((await spawn($, { fork: true })).deny).toMatch(/critical/)
  })

  test('a tight fork is let through with its model untouched: a fork ignores the model', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ budget: 3, running_agents: 2 }) } })
    expect((await spawn($, { fork: true, model: 'opus' })).model).toBe('opus')
  })

  // the claim asks danxbot now, every time: a verdict a tick has replaced is never decided on, in either direction
  test('the claim is decided on the answer as it is now: refused before, the very next spawn allowed after the dashboard changed', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = await session($, on, options)
    expect((await spawn($)).deny).toMatch(/critical/)
    options.pacingLine = { body: wire({ budget: 12, running_agents: 5 }) }
    await d.clock.advance(1_000)
    expect((await spawn($)).deny).toBeUndefined()
  })

  test('and the other way: allowed before, the very next spawn refused after the dashboard changed', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } }
    const d = await session($, on, options)
    expect((await spawn($)).deny).toBeUndefined()
    options.pacingLine = { body: wire({ budget: 3, running_agents: 11 }) }
    await d.clock.advance(1_000)
    expect((await spawn($)).deny).toMatch(/agent\(s\) already run on this account against budget 3/)
  })

  test('a relayed event never claims or reads the line: a slow dashboard cannot stall event delivery', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12 }) } }
    const d = await session($, on, options)
    const before = d.pacingReads.length
    d.relay.push({ cursor: 'c1', text: '[danx-dashboard stream] Usage pacing for your Claude account changed: on pace.' })
    await d.clock.settle()
    expect(d.pacingReads).toHaveLength(before)
    expect(d.claimAttempts.n).toBe(0)
    expect(d.relay.delivered).toHaveLength(1)
  })

  test('the sub-agent that a claim started is handed the line of the answer that claimed it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } })
    await spawn($)
    expect(await subagentLine($, d)).toBe('Pacing line.')
  })

  // FAIL CLOSED (DX-5593): a signed-in session whose claim cannot be made is refused, because an allowed spawn there is an agent nobody counted
  describe('a claim that cannot be made refuses the spawn, and says why once', () => {
    test('a claim that outlasts its deadline: refused, told once; the late answer changes nothing', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } }
      const d = await session($, on, options)
      options.pacingHoldMs = PACING_READ_DEADLINE_MS + 1_000
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      const r = await pending
      expect(r.deny).toMatch(/^Usage pacing: the spawn could not claim its slot/)
      expect(r.deny).toContain(`${PACING_READ_DEADLINE_MS} ms deadline`)
      expect(claimToasts(d)).toHaveLength(1)
      await d.clock.advance(1_000)
      options.pacingHoldMs = undefined
      expect((await spawn($)).deny).toBeUndefined()
    })

    test("an error answer (500) and the dashboard's 404: refused, told once however many spawns repeat it; the route recovering is seen at once", async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { status: 500 } }
      const d = await session($, on, options)
      const from = d.toasts.length
      expect((await spawn($)).deny).toMatch(/answered 500/)
      expect((await spawn($)).deny).toMatch(/answered 500/)
      expect(claimToasts(d, from)).toHaveLength(1)
      options.pacingLine = { status: 404 }
      expect((await spawn($)).deny).toMatch(/answered 404/)
      expect(claimToasts(d, from)).toHaveLength(2)
      options.pacingLine = { body: wire({ budget: 12, running_agents: 5 }) }
      expect((await spawn($)).deny).toBeUndefined()
    })

    test('a malformed answer is a failed claim, never an allow', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: { nonsense: true } } })
      expect((await spawn($)).deny).toMatch(/could not claim its slot/)
      expect(claimToasts(d)).toHaveLength(1)
      expect(d.claimsAllowed).toEqual([])
    })

    test("a call auto mode's classifier refused is told as the person's sentence, never `answered 0`", async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } })
      d.setMcp('refused')
      expect((await spawn($)).deny).toContain(BLOCKED_LINE)
      expect(claimToasts(d)).toEqual([`Usage pacing could not claim a slot, so the spawn was refused (the budget is a strict cap): ${BLOCKED_LINE}`])
    })

    test('a call that never reached the server (status 0, no refusal) is told with its own reason', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } })
      d.setMcp('flaky')
      expect((await spawn($)).deny).toContain('request timed out after 60000ms')
      expect(claimToasts(d)).toHaveLength(1)
      expect(claimToasts(d)[0]).toContain('mcp: danxbot: $.mcp.call: request timed out after 60000ms')
    })
  })

  // DX-5593 (C1): a claim the host's refusal gives back is told when the give-back fails; the 60 s lapse in danxbot stays the recovery
  describe('a claim that cannot be given back is told once per text, never silently', () => {
    test('an error answer (400): the host refusal still stands, told once however many repeat it', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, running_agents: 0 }) }, claimRelease: { status: 400 } })
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect(giveBackToasts(d)).toHaveLength(1)
      expect(giveBackToasts(d)[0]).toContain('answered 400')
      expect(claimToasts(d)).toEqual([])
    })

    test('an error answer (500) is told once too, and a different text is told again', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 9, running_agents: 0 }) }, claimRelease: { status: 500 } }
      const d = await session($, on, options)
      await spawn($, { prompt: 'refuse' })
      await spawn($, { prompt: 'refuse' })
      expect(giveBackToasts(d)).toHaveLength(1)
      expect(giveBackToasts(d)[0]).toContain('answered 500')
      options.claimRelease = { status: 400 }
      await spawn($, { prompt: 'refuse' })
      expect(giveBackToasts(d)).toHaveLength(2)
    })

    test('{released:false} (a claim danxbot no longer holds) is normal: nothing is told', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, running_agents: 0 }) }, claimRelease: { body: { released: false } } })
      expect((await spawn($, { prompt: 'refuse' })).deny).toBe('host refused')
      expect(d.claimsReleased).toHaveLength(1)
      expect(giveBackToasts(d)).toEqual([])
    })

    test('an unreachable server of a signed-in session is told once', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, running_agents: 0 }) } })
      expect((await spawn($, { prompt: 'refuse-and-drop' })).deny).toBe('host refused')
      expect(giveBackToasts(d)).toHaveLength(1)
      expect(giveBackToasts(d)[0]).toContain('not reachable')
    })

    test('a give-back that throws or times out, for a signed-in session, is told once per text', async () => {
      for (const mode of ['throws', 'times out'] as const) {
        resetPacing()
        const toasts: string[] = []
        const env: PacingEnv = {
          now: () => Promise.resolve(0),
          within: mode === 'times out' ? (_ms, _work, onTimeout) => onTimeout() : (_ms, work) => work,
          call: mode === 'times out' ? () => new Promise<never>(() => {}) : () => Promise.reject(new Error('boom')),
          reading: () => Promise.resolve(null),
          signedIn: () => Promise.resolve(true),
          sleep: () => Promise.resolve(),
          toast: t => void toasts.push(t),
        }
        await releaseClaim(env, 'c1')
        await releaseClaim(env, 'c1')
        expect(toasts).toHaveLength(1)
        expect(toasts[0]).toContain('until it lapses')
      }
    })

    test('a give-back that throws for a signed-out session stays silent', async () => {
      resetPacing()
      const toasts: string[] = []
      const env: PacingEnv = { now: () => Promise.resolve(0), within: (_ms, work) => work, call: () => Promise.reject(new Error('boom')), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(false), sleep: () => Promise.resolve(), toast: t => void toasts.push(t) }
      await releaseClaim(env, 'c1')
      expect(toasts).toEqual([])
    })

    test('a good give-back tells nothing', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ budget: 9, running_agents: 0 }) } })
      await spawn($, { prompt: 'refuse' })
      expect(d.claimsReleased).toHaveLength(1)
      expect(giveBackToasts(d)).toEqual([])
    })
  })

  // a refusal told once is told again when it comes back after a good claim
  test('a good claim resets the once-per-text rule of the claim toasts', async ($, on) => {
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } }
    const d = await session($, on, options)
    options.pacingLine = { status: 500 }
    expect((await spawn($)).deny).toMatch(/answered 500/)
    expect((await spawn($)).deny).toMatch(/answered 500/)
    expect(claimToasts(d)).toHaveLength(1)
    options.pacingLine = { body: wire({ budget: 12, running_agents: 5 }) }
    expect((await spawn($)).deny).toBeUndefined()
    options.pacingLine = { status: 500 }
    expect((await spawn($)).deny).toMatch(/answered 500/)
    expect(claimToasts(d)).toHaveLength(2)
  })

  // DX-5593 (B1): whether a session is outside pacing is a fact about the session, never about the connection
  describe('a session known to be signed in whose server cannot be reached is refused', () => {
    test('the server drops after a good claim: the spawn is refused, one toast that says it was refused', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } }
      const d = await session($, on, options)
      expect((await spawn($)).deny).toBeUndefined()
      options.mcp = 'down'
      const r = await spawn($)
      expect(r.deny).toMatch(/^Usage pacing: the spawn could not claim its slot/)
      expect(r.deny).toContain('not reachable')
      expect(claimToasts(d)).toHaveLength(1)
      expect(claimToasts(d)[0]).not.toContain('not paced')
      expect(d.claimsAllowed).toHaveLength(1)
    })

    // the session-start read failed, so no read or claim has succeeded: only the plan view says the session is signed in (`env.signedIn()`)
    test('the session-start pacing read failed, the session is signed in, and the server then drops: refused, not looked for again', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { status: 500 } }
      const d = await session($, on, options)
      options.mcp = 'down'
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      const r = await pending
      expect(r.deny).toMatch(/^Usage pacing: the spawn could not claim its slot/)
      expect(r.deny).toContain('not reachable')
      expect(d.claimsAllowed).toEqual([])
    })

    test('the server drops before any claim, with the plan view loaded: refused', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ budget: 12, running_agents: 5 }) } }
      await session($, on, options)
      options.mcp = 'down'
      expect((await spawn($)).deny).toMatch(/^Usage pacing:/)
    })
  })

  // outside pacing: danxbot counts none of the agents of a session it does not know, so it holds none of its spawns
  describe('a session outside pacing is allowed, silently, with nothing claimed', () => {
    test('no danx-dashboard MCP server connected: every spawn looks again until the claim's own deadline, none is told', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { mcp: 'down' }
      const d = await session($, on, options)
      // the fake clock runs past the plugin's own deadline, so it is that deadline that ends each spawn's wait, not the engine's hook budget
      for (let i = 0; i < 2; i++) {
        const pending = spawn($)
        await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
        expect((await pending).deny).toBeUndefined()
      }
      expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toEqual([])
      // each spawn looked again more than once inside its deadline
      expect(d.claimAttempts.n).toBeGreaterThanOrEqual(4)
      options.mcp = 'up'
      options.pacingLine = { body: wire({ level: 'critical', budget: 0 }) }
      expect((await spawn($)).deny).toMatch(/critical/)
    })

    test('a server that never connects in the claim deadline: allowed, outside pacing (DX-5593 problem 2503, the operator has not decided)', async ($, on) => {
      const d = await session($, on, { mcp: 'down' })
      const pending = spawn($)
      await d.clock.advance(PACING_READ_DEADLINE_MS + 1)
      expect((await pending).deny).toBeUndefined()
      expect(d.claimsAllowed).toEqual([])
      expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toEqual([])
    })

    test('a server that connects within the claim deadline is claimed against, not skipped', async ($, on) => {
      const options: Parameters<typeof dashboard>[1] = { mcp: 'down', pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
      const d = await session($, on, options)
      const spawning = spawn($)
      // the server is not up at the first look: it comes up between looks, and only the poll loop finds it
      await d.clock.settle()
      await d.clock.advance(1_000)
      options.mcp = 'up'
      await d.clock.advance(1_000)
      expect((await spawning).deny).toMatch(/critical/)
    })
    test('a signed-out session (never signed in, lapsed, revoked): allowed, nothing told', async ($, on) => {
      const d = await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
      d.world.signedOut = 'lapsed'
      expect((await spawn($)).deny).toBeUndefined()
      expect(claimToasts(d)).toEqual([])
    })
  })

  test('reads the line at session start, and a spawn claims instead of reading it', async ($, on) => {
    const d = await session($, on, { pacingLine: { body: wire() } })
    expect(d.pacingReads).toHaveLength(1)
    await spawn($)
    await spawn($)
    expect(d.pacingReads).toHaveLength(1)
    expect(d.claimAttempts.n).toBe(2)
  })

  test('a tool call of any tool is never denied under a critical verdict: saving work stays possible', async ($, on) => {
    await session($, on, { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } })
    for (const tool of ['Bash', 'Write', 'mcp__plugin_danxbot_danx-dashboard__danxbot_api']) {
      const r = await $.tool.call({ tool, command: 'git commit -m x' } as any)
      expect(r.deny).toBeUndefined()
      expect(r.isError).not.toBe(true)
      expect(r.text).toBe('ran')
    }
  })
})

describe('failures of the guard itself', () => {
  test('a hook error (a rejecting clock) is told once per text, never a toast per spawn, and the spawn is refused: it could not claim its slot', async () => {
    resetPacing()
    const toasts: string[] = []
    const env: PacingEnv = { now: () => Promise.reject(new Error('clock down')), within: (_ms, work) => work, call: () => Promise.reject(new Error('never reached')), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(false), sleep: () => Promise.resolve(), toast: t => void toasts.push(t) }
    const started = { model: 'm', agentId: 'a' }
    const guard = spawnGuard(env)
    const e = { prompt: 'p', subagentType: 'general-purpose', background: false, fork: false, parentModel: 'opus' } as any
    for (let i = 0; i < 2; i++) expect((await guard(e, async () => started)).deny).toMatch(/^Usage pacing: the spawn could not claim its slot.*clock down/)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('clock down')
  })

  test('a refusal starts with the prefix the skill quotes', () => {
    expect((decideSpawn(v({ level: 'critical', budget: 0 }), 'opus') as { reason: string }).reason.startsWith(REFUSAL_PREFIX)).toBe(true)
    expect(REFUSAL_PREFIX).toBe('Usage pacing:')
  })
})

describe('a second session in the same process', () => {
  test('never inherits the previous session\'s last good answer or state', async ($, on) => {
    resetPacing()
    on('agent.spawn', (_$: any, e: any) => ({ model: e.model ?? 'm', agentId: 'new' }) as any)
    const options: Parameters<typeof dashboard>[1] = { pacingLine: { body: wire({ level: 'critical', budget: 0 }) } }
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    expect((await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose' })).deny).toMatch(/critical/)
    // the next session's claim fails: it is refused as a failed claim, never paced by the last session's critical answer
    options.pacingLine = { status: 500 }
    await startSession($, d, 'desktop')
    const next = (await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose' })).deny
    expect(next).toMatch(/could not claim its slot/)
    expect(next).not.toMatch(/critical/)
  })
})

describe('what register wires', () => {
  test('agent.spawn carries the pacing guard, and no tool.call handler can carry it', () => {
    const wired: { event: string; matcher: unknown }[] = []
    register(((event: string, ...rest: unknown[]) => void wired.push({ event, matcher: rest.length > 1 ? rest[0] : undefined })) as any, {} as any)
    expect(wired.filter(w => w.event === 'agent.spawn')).toHaveLength(1)
    // every tool.call hook is matched to one danx-dashboard tool, but the time stamp (DX-4234), which only adds context to a finished call and
    // answers its result as it came (context-stamp.test.tsx): the guard is no tool.call handler, so none can sit on a commit, push or card write
    const toolCalls = wired.filter(w => w.event === 'tool.call')
    expect(toolCalls.filter(w => w.matcher === undefined)).toHaveLength(1)
    const matched = toolCalls.filter(w => w.matcher !== undefined)
    expect(matched.length).toBeGreaterThan(0)
    for (const w of matched) expect((w.matcher as { tool?: string })?.tool).toMatch(/^mcp__(plugin_danxbot_)?danx-dashboard__(plan_connect|request_permission)$/)
  })
})
