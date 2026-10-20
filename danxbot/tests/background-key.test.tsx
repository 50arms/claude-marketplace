// DX-5062: every danxbot_api call a hook makes carries `background: true` (the current MCP accepts it) and there is no retry without it:
// an MCP that refuses the key fails the call once, and the failure is told with its fix.
import { describe, expect } from 'claude-code/testing'

import { errText } from '../hooks/plan/load'
import { STALE_MCP_LINE, isStaleMcpRefusal } from '../hooks/relay/refusal'
import { TOAST_ERROR_MAX } from '../hooks/plan/config'
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
      expect(d.toasts.filter(t => t.includes(STALE_MCP_LINE))).toHaveLength(1)
    })

    test('an MCP that refuses the key from the session start: every toast that says to restart carries the whole sentence, the plan-load toast included', async ($, on) => {
      answerReportEvents(on)
      const d = dashboard(on, { mcp: 'strictKeys' })
      await startSession($, d, surface)
      await $.classic.SubagentStart(START)
      await d.clock.settle()
      const restart = d.toasts.filter(t => /restart/i.test(t))
      expect(restart.some(t => t === `Plan load failed: ${STALE_MCP_LINE}`)).toBe(true)
      for (const t of restart) expect(t).toContain(STALE_MCP_LINE)
      expect(d.toasts.some(t => /\bmcp: /.test(t) && t.includes('background'))).toBe(false)
    })
  })
}

describe('which refusal is an MCP older than the plugin', () => {
  const STRICT = `MCP error -32602: Input validation error: Invalid arguments for tool danxbot_api: [ { "code": "unrecognized_keys", "keys": [ "background" ], "path": [], "message": "Unrecognized key(s) in object: 'background'" } ]`

  test('the strict-schema refusal of the background key is one', () => {
    expect(isStaleMcpRefusal(STRICT)).toBe(true)
  })

  test('an unrecognized key that is not background is some other failure', () => {
    expect(isStaleMcpRefusal(STRICT.replaceAll('background', 'board_slug'))).toBe(false)
  })

  test('a failure that mentions background but is no unrecognized key is some other failure', () => {
    expect(isStaleMcpRefusal('MCP error -32603: the background report could not be written')).toBe(false)
  })

  test('the sentence stays whole behind the plan-load toast prefix, the longest this failure reaches', () => {
    expect(`Plan load failed: ${STALE_MCP_LINE}`.length).toBeLessThanOrEqual(TOAST_ERROR_MAX)
  })

  test('a failure marked as a sentence is shown as it is; any other keeps its status prefix', () => {
    expect(errText({ ok: false, status: 0, body: { error: STALE_MCP_LINE }, sentence: true })).toBe(STALE_MCP_LINE)
    expect(errText({ ok: false, status: 0, body: { error: STALE_MCP_LINE } })).toBe(`mcp: ${STALE_MCP_LINE}`)
  })
})
