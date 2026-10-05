// DX-4340 (PLAN-29 section 3): a new sub-agent is handed danxbot's pacing line (GET /api/pacing/line) as SubagentStart additionalContext,
// from the same cache the spawn guard reads. Unknown is explicit on the wire (reason set, line null): then it is told nothing. A failed
// read starts the sub-agent without a line and toasts once.
import { describe, expect, test } from 'claude-code/testing'

import { parsePacing, pacingLine, refreshPacing, resetPacing } from '../hooks/plan/pacing-line'
import type { PacingEnv } from '../hooks/plan/pacing-line'
import { dashboard, startSession } from './plan-kit'

const LINE = 'Pacing: this account is over pace; 0 agents may run on the account until 2026-10-08 12:00 UTC. Do the work yourself, cheaply.'
const known = { account: 'uuid:u1', level: 'over_pace', budget: 0, resets_at: '2026-10-08T12:00:00.000Z', running_agents: 2, line: LINE, spend: null, reason: null }
const unknown = { account: null, level: null, budget: null, resets_at: null, running_agents: null, line: null, reason: 'no_usage_account' }
const START = { agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' } as any

describe('parsePacing', () => {
  test('the verdict and line, null for an explicit unknown, an error for anything else', () => {
    expect(parsePacing(known)).toEqual({ verdict: { level: 'over_pace', budget: 0, resetsAt: '2026-10-08T12:00:00.000Z', runningAgents: 2 }, line: LINE, spend: null })
    expect(parsePacing(unknown)).toBeNull()
    expect(parsePacing({ ...unknown, reason: null })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, level: 'fine' })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, budget: -1 })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, running_agents: null })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, line: '  ' })).toEqual({ error: expect.any(String) })
    expect(parsePacing(null)).toEqual({ error: expect.any(String) })
  })

  // DX-4595: the server's spend figure rides the known answer; null stays null, anything else unreadable is loud
  test('spend is the server figure or null, and a missing or malformed spend is an error', () => {
    const spend = { used_percent: 82.4, level: 'critical', resets_at: '2026-10-08T12:00:00.000Z', spent_usd: 41.2, budget_usd: 50 }
    expect(parsePacing({ ...known, spend })).toMatchObject({ spend: { usedPercent: 82.4, level: 'critical', resetsAt: '2026-10-08T12:00:00.000Z', spentUsd: 41.2, budgetUsd: 50 } })
    expect(parsePacing({ ...known, spend: null })).toMatchObject({ spend: null })
    const { spend: _omit, ...without } = known
    expect(parsePacing(without)).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, spend: { ...spend, level: 'fine' } })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, spend: { ...spend, spent_usd: '41' } })).toEqual({ error: expect.any(String) })
    expect(parsePacing({ ...known, spend: { ...spend, resets_at: null } })).toEqual({ error: expect.any(String) })
  })
})

describe('the SubagentStart pacing line', () => {
  async function started($: any, on: any, options: Parameters<typeof dashboard>[1]) {
    resetPacing()
    on('classic.SubagentStart', () => ({}) as any)
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    return { d, r: await $.classic.SubagentStart(START) }
  }

  test('hands the line to the new sub-agent as additionalContext', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { body: known } })
    expect(r.additionalContext).toEqual([LINE])
    // one read at session start serves the sub-agent start too
    expect(d.pacingReads).toHaveLength(1)
  })

  test('says nothing when danxbot has no line for this session', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { body: unknown } })
    expect(r.additionalContext).toBeUndefined()
    expect(d.toasts.filter(t => t.startsWith('Usage pacing'))).toEqual([])
  })

  test('a failed read starts the sub-agent without a line', async ($, on) => {
    const { r } = await started($, on, { pacingLine: { status: 500 } })
    expect(r.additionalContext).toBeUndefined()
  })
})

describe('a clock that rejects', () => {
  const env = (toasts: string[]): PacingEnv => ({ now: () => Promise.reject(new Error('clock down')), call: () => Promise.reject(new Error('never reached')), toast: t => void toasts.push(t) })

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
