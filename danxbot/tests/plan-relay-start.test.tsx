// DX-4233: when the plan event relay (the module's loop on the danx-dashboard server's plan_events_wait tool) starts, and when it does not.
import { describe, expect } from 'claude-code/testing'

import { SERVER, toolName } from '../hooks/plan/config'
import { WAIT_MS } from '../hooks/relay/config'
import { test, SURFACES, answerPlanConnect, dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const URL_A = 'https://danxbot.example/connect/aaaa'
const required = JSON.stringify({ state: 'approval_required', approvalUrl: URL_A, confirmCode: 'NXGUF88G', expiresAt: '2026-10-03T08:10:00.000Z', instruction: 'Show the code.' })
const pending = JSON.stringify({ state: 'approval_pending', approvalUrl: URL_A, confirmCode: 'NXGUF88G', expiresAt: 'x', instruction: 'Wait.' })

for (const surface of SURFACES) {
  describe(`the relay starts on ${surface}`, () => {
    test('on session.start of a connected session: one wait, no cursor, no transcript path before one is known', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      expect(d.relay.calls).toEqual([{ plan_id: 23, cursor: null, timeout_ms: WAIT_MS }])
      // the wait is held by the server: no second call while nothing happens
      await d.clock.advance(60_000)
      expect(d.relay.calls).toHaveLength(1)
    })

    test("on the model's plan_connect", async ($, on) => {
      const d = dashboard(on, { connected: false })
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([null])
      await $.tool.call({ tool: toolName('plan_connect'), plan_id: 23 } as any)
      await d.clock.settle()
      expect(d.relay.calls).toEqual([{ plan_id: null, cursor: null, timeout_ms: WAIT_MS }, { plan_id: 23, cursor: null, timeout_ms: WAIT_MS }])
      // the calls (the no-plan one, then the plan's) reached the plugin's own server
      expect(d.calls.filter(c => c.tool === 'plan_events_wait' && c.server === SERVER)).toHaveLength(2)
    })

    // DX-4884: a signed-in session on no plan still runs the relay, for its session records (pacing, auto-resume)
    test('for a signed-in session on no plan: one wait with plan_id null, and a pacing record wakes it', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      await d.clock.settle()
      expect(d.relay.calls).toEqual([{ plan_id: null, cursor: null, timeout_ms: WAIT_MS }])
      d.relay.push({ cursor: 'p1', text: 'critical pacing stop', urgent: true })
      await d.clock.settle()
      expect(d.relay.delivered).toHaveLength(1)
    })

    test('not for a signed-out session', async ($, on) => {
      const d = dashboard(on, { signedOut: 'signed-out' })
      await startSession($, d, surface)
      await d.clock.advance(120_000)
      expect(d.relay.calls).toHaveLength(0)
    })

    for (const [name, answer] of [['approval_required', required], ['approval_pending', pending]] as const) {
      test(`not for a plan_connect that answered ${name}: nothing is connected yet`, async ($, on) => {
        const d = dashboard(on, { signedOut: 'signed-out' })
        d.world.signIn.answer = { text: pending, waits: true }
        on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => ({ result: {}, text: answer, isError: false }) as any)
        await startSession($, d, surface)
        await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23 } as any)
        await d.clock.settle()
        expect(d.relay.calls).toHaveLength(0)
      })
    }

    test('after a leave: the plan wait is dropped, the session runs its own (plan_id null) and a record is delivered once', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(d.relay.calls).toHaveLength(1)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, null])
      d.relay.push({ cursor: 'c5', text: 'after the leave' })
      await d.clock.advance(60_000)
      expect(d.relay.calls.map(c => c.plan_id)).toEqual([23, null, null])
      expect(d.relay.delivered).toHaveLength(1)
    })
  })
}
