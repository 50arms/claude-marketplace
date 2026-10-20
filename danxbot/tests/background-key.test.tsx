// DX-5062: every danxbot_api call a hook makes carries `background: true` (the current MCP accepts it) and there is no retry without it:
// an MCP that refuses the key fails the call once, and the failure is told with its fix.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, answerReportEvents, activityRows, dashboard, startSession } from './plan-kit'

const START = { agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high' }

for (const surface of SURFACES) {
  describe(`hook reports carry the background key, on ${surface}`, () => {
    test('the sub-agent start is reported, marked background: true', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(activityRows(d).map(r => r.activityId)).toEqual(['agent-a1b2c3'])
      expect(d.unmarked).toEqual([])
    })

    test('an MCP that refuses the key is called once, never retried without it, and the failure names the fix', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      d.setMcp('strictKeys')
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(d.backgroundRefusals.filter(c => c === 'POST /api/plan-sessions/me/activity')).toHaveLength(1)
      expect(activityRows(d)).toEqual([])
      expect(d.toasts.filter(t => /restart the session so the current MCP starts/.test(t))).toHaveLength(1)
    })
  })
}
