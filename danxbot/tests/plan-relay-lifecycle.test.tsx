// DX-4233: the relay's life: one loop at a time, a move to another plan restarts it, the end of the process stops it, /clear and
// resume do not.
import { describe, expect, test } from 'claude-code/testing'

import { WAIT_MS } from '../hooks/relay/config'
import { SURFACES, answerPlanConnect, dashboard, startSession } from './plan-kit'

const answer = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })

for (const surface of SURFACES) {
  describe(`the relay's life on ${surface}`, () => {
    test('a connect to another plan restarts the loop with no cursor; the old loop answering late is ignored', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      // the first wait is held until the test lets it answer
      let release: () => void = () => {}
      const held = new Promise<void>(resolve => (release = resolve))
      d.relay.server.script.push(async () => (await held, answer({ events: [{ cursor: 'c9', text: 'a late event for the old plan' }] })))
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)

      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
      await d.clock.settle()
      expect(d.relay.calls).toEqual([
        { plan_id: 23, cursor: null, timeout_ms: WAIT_MS },
        { plan_id: 24, cursor: null, timeout_ms: WAIT_MS },
      ])

      release()
      await d.clock.settle()
      expect(d.relay.delivered).toEqual([])
      // no third wait: the dead loop did not carry on
      expect(d.relay.calls).toHaveLength(2)
    })

    for (const reason of ['prompt_input_exit', 'logout', 'other']) {
      test(`session.end (${reason}) stops it: no wait is made and no event is delivered after`, async ($, on) => {
        const d = dashboard(on)
        on('session.end', () => ({ sessionId: 's1' }) as any)
        await startSession($, d, surface)
        await $.session.end({ reason } as any)
        await d.clock.settle()
        const calls = d.relay.calls.length
        d.relay.push({ cursor: 'c5', text: 'after the end' })
        await d.clock.advance(180_000)
        expect(d.relay.calls).toHaveLength(calls)
        expect(d.relay.delivered).toEqual([])
      })
    }

    for (const reason of ['clear', 'resume']) {
      test(`session.end (${reason}) does not stop it: the next event is delivered`, async ($, on) => {
        const d = dashboard(on)
        on('session.end', () => ({ sessionId: 's1' }) as any)
        await startSession($, d, surface)
        await $.session.end({ reason } as any)
        await d.clock.settle()
        d.relay.push({ cursor: 'c5', text: 'after the clear' })
        await d.clock.settle()
        expect(d.relay.delivered.map(x => x.text)).toEqual(['[danxbot plan event] after the clear'])
      })
    }

    test('a repeated session.start keeps exactly one loop (starting the relay twice is idempotent)', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      await startSession($, d, surface)
      await startSession($, d, surface)
      expect(d.relay.calls).toHaveLength(1)
      d.relay.push({ cursor: 'c5', text: 'once' })
      await d.clock.settle()
      expect(d.relay.delivered).toHaveLength(1)
      // one wait is pending again, not three
      expect(d.relay.calls).toHaveLength(2)
    })
  })
}
