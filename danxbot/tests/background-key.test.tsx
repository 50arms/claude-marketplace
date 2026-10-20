// DX-5062: every danxbot_api call a hook makes carries `background: true` (the published MCP, 0.1.339, accepts it) and there is no retry without it:
// a server that refuses the key fails the call like any other dashboard failure.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, answerReportEvents, dashboard, startSession } from './plan-kit'

const START = { agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high' }

for (const surface of SURFACES) {
  describe(`hook reports carry the background key, on ${surface}`, () => {
    test('every danxbot_api call is marked background: true', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(d.unmarked).toEqual([])
    })
  })
}
