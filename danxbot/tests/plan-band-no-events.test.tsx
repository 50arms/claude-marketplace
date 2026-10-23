import "./run-tests-with-npm-test.generated"
// DX-5605: the plan band draws sign-in, the plan and Disconnect only. Whatever the plan event relay or the dashboard's listener is doing
// (connecting, retrying, stopped, an unhealthy listener), the band shows no events or relay text: that fact lives in the session's stored
// events warning and its toast, which these tests read alongside.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, bandSilent, bandLabelOf, dashboard, eventsWarned, relayPhase, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } } as any

// the band still carries what it is for: the plan's name and Disconnect
const expectBandIntact = async (band: any) => {
  expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
  expect(await band.find({ key: 'disconnect' })).toBeDefined()
}

for (const surface of SURFACES) {
  describe(`the band draws no events or relay text on ${surface}`, () => {
    test('while the relay is still connecting (not running yet) and the listener is unhealthy', async ($, on) => {
      const d = dashboard(on, { listener: 'reconnecting' })
      d.seedRelay({ phase: 'off', planId: 23, detail: null })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(eventsWarned(d)).not.toBeNull()
      await bandSilent(band)
      await expectBandIntact(band)
    })

    test('while the relay is retrying a failing call', async ($, on) => {
      const d = dashboard(on)
      for (let i = 0; i < 3; i++) d.relay.server.script.push(() => ({ deny: 'request timed out after 60000ms' }) as any)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(relayPhase(d)).toBe('retrying')
      expect(eventsWarned(d)).toBe('events: relay retrying')
      expect(d.toasts.some(t => t.startsWith('events: relay retrying'))).toBe(true)
      await bandSilent(band)
      await expectBandIntact(band)
    })

    test('after the server stopped the relay', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'relay_failed', detail: 'the relay cannot go on', fix: 'Connect this session to a plan with plan_connect' }
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(relayPhase(d)).toBe('stopped')
      expect(eventsWarned(d)).toBe('events: relay stopped')
      await bandSilent(band)
      await expectBandIntact(band)
    })
  })
}
