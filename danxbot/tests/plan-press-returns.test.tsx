// DX-4635: a Disconnect press returns once its own plan_connect outcome is known and shown; the refresh, the
// model's note and the syncs run detached, their failures still shown, and the card reads of one load overlap.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const SLOW_MS = 30_000

for (const surface of SURFACES) {
  describe(`a Disconnect press returns before the refresh on ${surface}`, () => {
    test('Disconnect: the press resolves while the refresh is slow and the band shows not connected', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.holdApi(SLOW_MS)
      const press = band.press({ key: 'disconnect' })
      await d.clock.advance(1_000)
      await press
      expect(d.toasts).toContain('Disconnected from PLAN-23')
      expect(await text(band)).toContain('Danxbot: not connected to a plan')
      expect(d.relay.told).toHaveLength(1)
      d.holdApi(0)
      await d.clock.settle()
      expect(await text(band)).toContain('Danxbot: not connected to a plan')
    })

    test('a detached task that throws is toasted under its own name, not a press update', async ($, on) => {
      const d = dashboard(on)
      // the host refuses the view write, in the load and again in its error handler: the throw escapes the session-start refresh
      d.failViewWrite()
      await startSession($, d, surface)
      expect(d.refusedViewWrites()).toBeGreaterThan(0)
      expect(d.toasts.some(t => t.startsWith('Plan refresh failed: '))).toBe(true)
      expect(d.toasts.some(t => t.startsWith('Plan update failed'))).toBe(false)
    })
  })
}
