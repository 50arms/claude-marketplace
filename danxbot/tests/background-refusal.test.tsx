// DX-5066: a session that started on a danxbot MCP older than 0.1.300 keeps that server when the plugin updates, and its strict schema refuses the
// `background` key DX-4997 added to every hook call. The hooks must still deliver every report: the first refusal is retried at once without the key
// and the session sends no more of it. A current MCP keeps getting `background: true`. The stand-in MCP's `legacyMcp` option models the old schema.
import { describe, expect } from 'claude-code/testing'

import { isBackgroundRefusal } from '../hooks/relay/refusal'
import { test, SURFACES, answerReportEvents, activityRows, dashboard, startSession } from './plan-kit'

const START = { agent_id: 'a1b2c3', agent_type: 'danxbot:worker-sonnet-high' }
const OLD_SERVER_WORDS =
  'MCP error -32602: Input validation error: Invalid arguments for tool danxbot_api: [ { "code": "unrecognized_keys", "keys": [ "background" ], "path": [], "message": "Unrecognized key(s) in object: \'background\'" } ]'

describe('what names a refusal of the background key (pure)', () => {
  test('the old server\'s words do', () => {
    expect(isBackgroundRefusal(OLD_SERVER_WORDS)).toBe(true)
  })

  test('another rejection, or another unrecognized key, does not', () => {
    expect(isBackgroundRefusal('request timed out after 60000ms')).toBe(false)
    expect(isBackgroundRefusal(OLD_SERVER_WORDS.replace(/background/g, 'other'))).toBe(false)
    expect(isBackgroundRefusal('the background task failed')).toBe(false)
  })
})

for (const surface of SURFACES) {
  describe(`hook reports through a danxbot MCP that refuses the background key, on ${surface}`, () => {
    test('every report is delivered, and once the key is refused it is no longer sent', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on, { legacyMcp: true })
      await startSession($, d, surface)
      // calls already in flight at the first refusal each meet it once; every call made after it goes without the key
      const refusedAtStart = d.backgroundRefusals.length
      expect(refusedAtStart).toBeGreaterThanOrEqual(1)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      await $.classic.SubagentStart({ ...START, agent_id: 'b4' })
      await d.clock.settle()
      expect(activityRows(d).map(r => r.activityId)).toEqual(['agent-a1b2c3', 'agent-b4'])
      expect(d.backgroundRefusals).toHaveLength(refusedAtStart)
      expect(d.unmarked).toEqual([])
    })

    test('a current MCP still receives background: true on every call and refuses nothing', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on)
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      expect(activityRows(d).map(r => r.activityId)).toEqual(['agent-a1b2c3'])
      expect(d.backgroundRefusals).toEqual([])
      expect(d.unmarked).toEqual([])
    })
  })
}
