// DX-4997 / DX-5033: the plugin's own dashboard reads are background work. The dashboard ends an agent pause on any UNMARKED request carrying the
// session header (the agent acting) and not on one marked `background: true`; the stand-in dashboard models that rule (`serverPauseRule` in the kit).
import { describe, expect } from 'claude-code/testing'

import { test, CLOCK_START, SURFACES, answerReportEvents, dashboard, forceRefresh, startSession } from './plan-kit'

const AGENT_PAUSE = () => ({ limit: 'agent', state: 'agent_waiting', reason: 'waiting for a build', ends_when: null, since: '2026-10-03T07:00:00.000Z', until: new Date(CLOCK_START + 3_600_000).toISOString(), held: 0 })

for (const surface of SURFACES) {
  describe(`the plugin's reads under an agent pause on ${surface}`, () => {
    test("the plugin's plan refresh, turn ends and Stop check do not end the pause; an unmarked plan read (the agent's own) does", async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.pause = AGENT_PAUSE()
      await forceRefresh($, d)
      await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any)
      await d.clock.settle()
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
      await d.clock.settle()
      expect(d.world.pause).toMatchObject({ limit: 'agent' })
      expect(d.unmarked).toEqual([])
      d.agentCall('GET', '/api/plans/mine')
      expect(d.world.pause).toBeNull()
    })

    test('the real Stop hook under an agent pause makes only marked calls and leaves the pause standing', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.world.pause = AGENT_PAUSE()
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
      await d.clock.settle()
      expect(d.world.pause).toMatchObject({ limit: 'agent' })
      expect(d.unmarked).toEqual([])
    })
  })
}
