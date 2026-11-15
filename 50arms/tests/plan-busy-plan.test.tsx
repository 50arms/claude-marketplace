import "./run-tests-with-npm-test.generated"
// CP-135: a plan with many In Progress cards kept the band on `50 Arms: Disconnected` (+ Sign in) while the session was connected: the in-progress read
// answered whole card rows, past the host's tool-result limit. The band now reads the compact row, and a load that fails for any reason but a missing
// server, a signed-out session or a revoked key never says Disconnected or offers Sign in.
import { describe, expect } from 'claude-code/testing'

import { test, bandLabelOf, SURFACES, dashboard, startSession, woken } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const buttons = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.text)

// a realistic In Progress answer: 14 cards (the PLAN-129 count that went over the limit), each with a long title like a real card's
const fourteenCards = () => Array.from({ length: 14 }, (_, i) => ({ id: `DX-${7400 + i}`, title: `Card ${i}: a realistic, fairly long card title that says what the work is and why it matters to the plan` }))

for (const surface of SURFACES) {
  describe(`a plan with many In Progress cards on ${surface}`, () => {
    test('14 In Progress cards: the band stays connected, offers no Sign in, and toasts nothing', async ($, on) => {
      const d = dashboard(on)
      d.world.inProgress = fourteenCards()
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      const all = await texts(band)
      expect(await bandLabelOf(band)).toContain('PLAN-23')
      expect(all).not.toContain('Disconnected')
      expect(await buttons(band)).not.toContain('Sign in')
      expect(d.toasts).toEqual([])
    })

    test('a load that fails with an answer is never Disconnected and offers no Sign in: it says the load failed and why, once', async ($, on) => {
      const d = dashboard(on, { inProgressFails: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      const all = await texts(band)
      expect(all).toContain('plan load failed')
      expect(all).toContain('500: in-progress boom')
      expect(all).not.toContain('Disconnected')
      expect(await buttons(band)).not.toContain('Sign in')
      expect(d.toasts.filter((t: string) => t.startsWith('Plan load failed'))).toHaveLength(1)
    })

    test('a session whose plugin server is not connected still reads Disconnected and offers Sign in', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await texts(band)).toContain('50 Arms: Disconnected')
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })

    test('a Sign in pressed while the session was never signed out tells the model nothing', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await texts(band)).toContain('Disconnected')
      d.setMcp('up')
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(woken(d)).toEqual([])
      expect(d.relay.told).toEqual([])
    })
  })
}
