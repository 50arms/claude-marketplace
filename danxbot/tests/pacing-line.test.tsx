import "./run-tests-with-npm-test.generated"
// DX-4340 (PLAN-29 section 3): a new sub-agent is handed danxbot's pacing line (GET /api/pacing/line) as SubagentStart additionalContext,
// from the one pacing cache (which the spawn guard's claim also writes). Unknown is explicit on the wire (reason set, line null): then it is told nothing. A failed
// read starts the sub-agent without a line and toasts once.
import { describe, expect } from 'claude-code/testing'

import { claimSlot, parsePacing, pacingLine, refreshPacing, resetPacing, slotWaiting } from '../hooks/plan/pacing-line'
import type { PacingEnv } from '../hooks/plan/pacing-line'
import { test, EVENT_TEXT, dashboard, startSession } from './plan-kit'

const LINE = 'Pacing: this account is over pace; 0 agents may run on the account until 2026-10-08 12:00 UTC. Do the work yourself, cheaply.'
const known = { account: 'uuid:u1', level: 'over_pace', budget: 0, resets_at: '2026-10-08T12:00:00.000Z', main_agents: 4, sub_agents: 2, reserved_agents: 0, line: LINE, spend: null, limits: [{ limit: 'five_hour', level: 'over_pace', state: 'hold', headroom_minutes: -30, resets_in_minutes: 100, used_percent: 96, target_percent: 95, critical_percent: 99, resets_at: '2026-10-08T12:00:00.000Z' }], worst_limit: 'five_hour', reason: null }
const unknown = { account: null, level: null, budget: null, resets_at: null, main_agents: null, sub_agents: null, reserved_agents: null, line: null, reason: 'no_usage_account' }
const START = { agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' } as any

describe('parsePacing', () => {
  test('the verdict and line, null for an explicit unknown, an error for anything else', () => {
    expect(parsePacing(known)).toEqual({ verdict: { level: 'over_pace', budget: 0, resetsAt: '2026-10-08T12:00:00.000Z', mainAgents: 4, subAgents: 2, reservedAgents: 0 }, line: LINE })
    expect(parsePacing(unknown)).toBeNull()
    expect(parsePacing({ ...unknown, reason: null })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, level: 'fine' })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, budget: -1 })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, sub_agents: null })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, reserved_agents: 3 })).toMatchObject({ verdict: { reservedAgents: 3 } })
    // DX-5595: reserved_agents is part of the one canonical shape of a known answer
    expect(parsePacing({ ...known, reserved_agents: null })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, reserved_agents: -1 })).toEqual({ error: expect.any(String) })
    const { reserved_agents: _r, ...noReserved } = known
    expect(parsePacing(noReserved)).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, line: '  ' })).toEqual({ error: expect.any(String) })
    expect(parsePacing(null)).toEqual({ error: expect.any(String) })
  })
})

describe('the SubagentStart pacing line', () => {
  async function started($: any, on: any, options: Parameters<typeof dashboard>[1]) {
    resetPacing()
    on('classic.SubagentStart', () => ({}) as any)
    // DX-5554: a signed-in session on no plan: the sub-agent gets the registry's event text first (context-event.test.tsx has that one), then the line
    const d = dashboard(on, { connected: false, ...options })
    await startSession($, d, 'desktop')
    const r = await $.classic.SubagentStart(START)
    // DX-4686: the start's live check is detached from the hook; let it end before the test does
    await d.clock.settle()
    return { d, r }
  }

  test('hands the line to the new sub-agent as additionalContext', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { body: known } })
    expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start'), LINE])
    // one read at session start serves the sub-agent start too
    expect(d.pacingReads).toHaveLength(1)
  })

  test('says nothing when danxbot has no line for this session', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { body: unknown } })
    expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
    expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toEqual([])
  })

  test('a failed read starts the sub-agent without a line', async ($, on) => {
    const { r } = await started($, on, { pacingLine: { status: 500 } })
    expect(r.additionalContext).toEqual([EVENT_TEXT('sub_agent_start')])
  })
})

describe('a clock that rejects', () => {
  const env = (toasts: string[]): PacingEnv => ({ now: () => Promise.reject(new Error('clock down')), within: (_ms, work) => work, call: () => Promise.reject(new Error('never reached')), reading: () => Promise.resolve(null), signedIn: () => Promise.resolve(false), sleep: () => Promise.resolve(), toast: t => void toasts.push(t) })

  test('is a failed read, told once: neither the line nor a forced session-start read rejects', async () => {
    resetPacing()
    const toasts: string[] = []
    expect(await pacingLine(env(toasts))).toBeNull()
    await expect(refreshPacing(env(toasts), true)).resolves.toBeUndefined()
    expect(await pacingLine(env(toasts))).toBeNull()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('clock down')
  })
})

describe('a session whose MCP server becomes unreachable', () => {
  test('toasts that the pacing read failed, once for a repeat of the same failure, and never says spawns are not paced', async () => {
    resetPacing()
    const toasts: string[] = []
    // DX-5593: the first read succeeds (an unreachable server is silent until one has), every later one finds the server gone
    const answers = [{ ok: true, status: 200, body: known }, { ok: false, status: 0, body: null, unreachable: true }]
    const env: PacingEnv = {
      now: () => Promise.resolve(0),
      within: (_ms, work) => work,
      call: () => Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]),
      reading: () => Promise.resolve(null),
      signedIn: () => Promise.resolve(true),
      sleep: () => Promise.resolve(),
      toast: t => void toasts.push(t),
    }
    await refreshPacing(env, true)
    expect(toasts).toEqual([])
    await refreshPacing(env, true)
    await refreshPacing(env, true)
    expect(toasts).toEqual(['Usage pacing could not be read (sub-agents get no pacing line until it can): the danx-dashboard MCP server is not reachable from this session'])
    expect(toasts[0]).not.toMatch(/not paced/i)
  })
})

describe('the slot-refused state (the title hourglass)', () => {
  // a verdict body with the claim's outcome on it: refused by `budget` (the cap is full) or claimed
  const verdict = (over: Record<string, unknown>) => ({ level: 'on_pace', budget: 1, resets_at: null, main_agents: 1, sub_agents: 1, reserved_agents: 0, line: LINE, ...over })
  const REFUSED = verdict({ claimed: false, claim_id: null, refusal: 'budget' })
  const CLAIMED = verdict({ sub_agents: 0, claimed: true, claim_id: 'claim-1' })
  // a env answering every call with `answer`; each change of the state is recorded with the state it changed to
  const envFor = (answer: unknown, flips: boolean[]): PacingEnv => ({
    now: () => Promise.resolve(0),
    within: (_ms, work) => work,
    call: () => Promise.resolve({ ok: true, status: 200, body: answer } as any),
    reading: () => Promise.resolve(null),
    signedIn: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
    toast: () => {},
    onSlotChange: () => flips.push(slotWaiting()),
  })

  test('a refused claim sets the state and the change redraws once; an admitted claim clears it', async () => {
    resetPacing()
    const flips: boolean[] = []
    expect((await claimSlot(envFor(REFUSED, flips))).kind).toBe('refused')
    expect(slotWaiting()).toBe(true)
    expect(flips).toEqual([true])
    // a second refusal changes nothing, so it redraws nothing
    await claimSlot(envFor(REFUSED, flips))
    expect(flips).toEqual([true])
    expect((await claimSlot(envFor(CLAIMED, flips))).kind).toBe('claimed')
    expect(slotWaiting()).toBe(false)
    expect(flips).toEqual([true, false])
  })

  test('a failed claim is not a refusal by pacing: the state is left as it was', async () => {
    resetPacing()
    const flips: boolean[] = []
    await claimSlot(envFor(REFUSED, flips))
    await claimSlot(envFor({ error: 'boom' }, flips))
    expect(slotWaiting()).toBe(true)
    expect(flips).toEqual([true])
  })

  test('a read showing a free slot (on pace, budget above running plus reserved) clears the state', async () => {
    resetPacing()
    const flips: boolean[] = []
    await claimSlot(envFor(REFUSED, flips))
    // 2 running-or-held against a budget of 2: no slot free
    await refreshPacing(envFor(verdict({ budget: 2, sub_agents: 1, reserved_agents: 1 }), flips), true)
    expect(slotWaiting()).toBe(true)
    await refreshPacing(envFor(verdict({ budget: 3, sub_agents: 1, reserved_agents: 0 }), flips), true)
    expect(slotWaiting()).toBe(false)
    expect(flips).toEqual([true, false])
  })

  test('a read with no free slot, or not on pace, keeps the state; a budget null is a free slot', async () => {
    resetPacing()
    const flips: boolean[] = []
    await claimSlot(envFor(REFUSED, flips))
    await refreshPacing(envFor(verdict({ budget: 2, sub_agents: 1, reserved_agents: 1 }), flips), true)
    expect(slotWaiting()).toBe(true)
    await refreshPacing(envFor(verdict({ level: 'over_pace', budget: 5, sub_agents: 0 }), flips), true)
    expect(slotWaiting()).toBe(true)
    await refreshPacing(envFor(verdict({ budget: null, sub_agents: 9 }), flips), true)
    expect(slotWaiting()).toBe(false)
  })

  test('a session start forgets the state', async () => {
    resetPacing()
    await claimSlot(envFor(REFUSED, []))
    expect(slotWaiting()).toBe(true)
    resetPacing()
    expect(slotWaiting()).toBe(false)
  })
})
