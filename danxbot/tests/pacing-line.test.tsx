// DX-4340 (PLAN-29 section 3): a new sub-agent is handed danxbot's pacing line (GET /api/pacing/line) as SubagentStart additionalContext.
// Unknown is explicit on the wire (reason set, line null): then it is told nothing. A failed read starts the sub-agent without a line and
// toasts once.
import { describe, expect, test } from 'claude-code/testing'

import { LINE_PATH, parseLine } from '../hooks/plan/pacing-line'
import { dashboard, startSession } from './plan-kit'

const LINE = 'Pacing: this account is over pace; 0 agents may run on the account until 2026-10-08 12:00 UTC. Do the work yourself, cheaply.'
const known = { account: 'uuid:u1', level: 'over_pace', budget: 0, resets_at: '2026-10-08T12:00:00.000Z', running_agents: 2, line: LINE, reason: null }
const unknown = { account: null, level: null, budget: null, resets_at: null, running_agents: null, line: null, reason: 'no_usage_account' }
const START = { agent_id: 'a1', agent_type: 'danxbot:worker-sonnet-high' } as any

describe('parseLine', () => {
  test('the line, null for an explicit unknown, an error for anything else', () => {
    expect(parseLine(known)).toBe(LINE)
    expect(parseLine(unknown)).toBeNull()
    expect(parseLine({ line: null })).toEqual({ error: expect.any(String) })
    expect(parseLine({ line: '  ', reason: null })).toEqual({ error: expect.any(String) })
    expect(parseLine(null)).toEqual({ error: expect.any(String) })
  })
})

describe('the SubagentStart pacing line', () => {
  async function started($: any, on: any, options: Parameters<typeof dashboard>[1]) {
    on('classic.SubagentStart', () => ({}) as any)
    const d = dashboard(on, options)
    await startSession($, d, 'desktop')
    return { d, r: await $.classic.SubagentStart(START) }
  }

  test('hands the line to the new sub-agent as additionalContext', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { body: known } })
    expect(r.additionalContext).toEqual([LINE])
    expect(d.api.filter(a => a.path === LINE_PATH)).toHaveLength(1)
  })

  test('says nothing when danxbot has no line for this session', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { body: unknown } })
    expect(r.additionalContext).toBeUndefined()
    expect(d.toasts.filter(t => t.startsWith('Usage pacing line'))).toEqual([])
  })

  test('a failed read starts the sub-agent without a line and says so once', async ($, on) => {
    const { d, r } = await started($, on, { pacingLine: { status: 500 } })
    expect(r.additionalContext).toBeUndefined()
    await $.classic.SubagentStart({ ...START, agent_id: 'a2' })
    expect(d.toasts.filter(t => t.startsWith('Usage pacing line'))).toHaveLength(1)
  })
})
