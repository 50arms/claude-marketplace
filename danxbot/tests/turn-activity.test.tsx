import "./run-tests-with-npm-test.generated"
// DX-5694: the session tells the dashboard what it is doing (idle, in a turn, compacting) and since when
// (PUT /api/plan-sessions/me/turn-activity, the channel DX-5693 fixed), so a card's Comments drawer can say why a comment is waiting.
import { describe, expect } from 'claude-code/testing'

import { afterCompaction, nextSince, turnActivityBody } from '../hooks/reports/turn-activity'
import { SURFACES, dashboard, startSession, test } from './plan-kit'

const COMPACTED = { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
const TRANSCRIPT = [{ role: 'user', text: 'go', toolUses: [], handle: 'm1' }]
const TURN = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any
const START = { prompt: 'go', turnId: 't1' } as any
const PUT = 'PUT /api/plan-sessions/me/turn-activity'

describe('the turn activity body (pure)', () => {
  test('since is an ISO-8601 UTC instant as Date#toISOString writes it', () => {
    expect(turnActivityBody('in_turn', Date.parse('2026-10-24T11:00:00.123Z'))).toEqual({ activity: 'in_turn', since: '2026-10-24T11:00:00.123Z' })
  })

  test('a change starts strictly after the last one sent, so the server (newest start wins) never drops it', () => {
    expect(nextSince(100, null)).toBe(100)
    expect(nextSince(100, 50)).toBe(100)
    expect(nextSince(100, 100)).toBe(101)
    expect(nextSince(90, 100)).toBe(101)
  })

  test('a compaction ends in the turn it interrupted, else idle', () => {
    expect(afterCompaction(true)).toBe('in_turn')
    expect(afterCompaction(false)).toBe('idle')
  })
})

for (const surface of SURFACES) {
  describe(`the turn activity reports on ${surface}`, () => {
    async function started($: any, on: any, compact: () => unknown = () => COMPACTED, onPlan = true) {
      on('classic.SessionStart', () => ({}) as any)
      on('classic.PreCompact', () => ({}) as any)
      on('tool.call', () => ({ result: {}, text: 'done' }) as any)
      on('session.compact', async () => compact() as any)
      on('turn.complete', () => ({ text: 'done' }) as any)
      const d = dashboard(on)
      if (!onPlan) d.world.planId = null
      await startSession($, d, surface)
      return d
    }
    const sent = (d: any) => d.turnActivity.map((c: any) => c.activity)

    test('a turn start sends in_turn and its end sends idle, each with when it began', async ($, on) => {
      const d = await started($, on)
      await d.clock.advance(1_000)
      const startedAt = new Date(d.clock.now()).toISOString()
      await $.turn.start(START)
      await d.clock.settle()
      await d.clock.advance(5_000)
      const endedAt = new Date(d.clock.now()).toISOString()
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.turnActivity).toEqual([
        { activity: 'in_turn', since: startedAt },
        { activity: 'idle', since: endedAt },
      ])
    })

    test("a sub-agent's turn is not the session's", async ($, on) => {
      const d = await started($, on)
      await $.turn.start({ ...START, agentId: 'a1' })
      await $.turn.complete({ ...TURN, agentId: 'a1' })
      await d.clock.settle()
      expect(d.turnActivity).toEqual([])
    })

    test('a compaction with no turn running sends compacting, then idle', async ($, on) => {
      const d = await started($, on)
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await d.clock.settle()
      expect(sent(d)).toEqual(['compacting', 'idle'])
      const [from, to] = d.turnActivity.map((c: any) => Date.parse(c.since))
      expect(to).toBeGreaterThan(from)
    })

    test('an automatic compaction in the middle of a turn ends back in_turn', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
      await d.clock.settle()
      expect(sent(d)).toEqual(['in_turn', 'compacting', 'in_turn'])
    })

    test('a compaction that throws still ends the compacting activity, and the error goes on', async ($, on) => {
      const d = await started($, on, () => {
        throw new Error('compact broke')
      })
      await expect($.session.compact({ trigger: 'manual', messages: TRANSCRIPT })).rejects.toThrow()
      await d.clock.settle()
      expect(sent(d)).toEqual(['compacting', 'idle'])
    })

    test("a sub-agent's compaction is not the session's", async ($, on) => {
      const d = await started($, on)
      await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT, agentId: 'a1' })
      await d.clock.settle()
      expect(d.turnActivity).toEqual([])
    })

    test('changes in the same millisecond still start strictly later, in order', async ($, on) => {
      const d = await started($, on)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      const [a, b] = d.turnActivity.map((c: any) => Date.parse(c.since))
      expect(b).toBeGreaterThan(a)
    })

    test('a send the dashboard refuses is one toast naming the refusal, not swallowed', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies[PUT] = { status: 409, body: { error: 'worker_session' } }
      await $.turn.start(START)
      await d.clock.settle()
      expect(d.toasts.filter((t: string) => t.startsWith('danxbot turn activity report failed'))).toHaveLength(1)
      expect(d.toasts.join('\n')).toContain('worker_session')
    })

    test('a send that cannot reach the dashboard is one toast too', async ($, on) => {
      const d = await started($, on)
      d.world.reportReplies[PUT] = { deny: 'request timed out after 60000ms' }
      await $.turn.start(START)
      await d.clock.settle()
      expect(d.toasts.filter((t: string) => t.startsWith('danxbot turn activity report failed'))).toHaveLength(1)
    })

    test('a session on no plan sends nothing', async ($, on) => {
      const d = await started($, on, () => COMPACTED, false)
      await $.turn.start(START)
      await $.turn.complete(TURN)
      await d.clock.settle()
      expect(d.turnActivity).toEqual([])
    })
  })
}
