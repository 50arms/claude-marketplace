import "./run-tests-with-npm-test.generated"
// CP-91: a session connected to a card shows the card's progress as the same donut a connected plan shows. The percent is its acceptance criteria passing over
// all of them, read as the two counts the card route serves (`ac_total`, `ac_done`), never its checklists: a long-worked card's checklists (every review round's
// findings) grew past what the host accepts and failed the whole band; a card with no criteria draws none; a read that cannot be read is the load's named error.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, dashboard, expectIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const CARD = { id: 'DX-77', title: 'One-off fix' }
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const ac = (ac_done: number, ac_total: number) => ({ ac_done, ac_total })

for (const surface of SURFACES) {
  describe(`the card donut on ${surface}`, () => {
    test('the acceptance-criteria counts are read from the held card, and nothing else of it, and drawn as the plan donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = ac(1, 4)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 25)
      if (surface === 'desktop') expect((await band.find({ type: 'Svg' }))?.props.width).toBe(16)
      const read = d.api.find(a => a.method === 'GET' && a.path === '/api/issues/DX-77')
      expect(read?.query).toEqual({ fields: { ac_total: true, ac_done: true } })
    })

    test('the percent is rounded to a whole number', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = ac(2, 3)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 67)
    })

    test('every criterion passing draws the done mark', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = ac(2, 2)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 100)
    })

    test('no criterion passing draws an empty donut, not none', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = ac(0, 1)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 0)
    })

    test('a card with no acceptance criteria draws no donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = ac(0, 0)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('One-off fix')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await text(band)).not.toMatch(/%|[○◔◑◕]/)
    })

    test('a session holding no card makes no card read and draws no donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = { id: 6, name: 'Tendai', avatar_url: null }
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(d.api.filter(a => a.path.startsWith('/api/issues/'))).toEqual([])
    })

    test('an answer without the counts is a named error: no guessed figure', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = { ac_total: 3 }
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('plan load failed')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
    })

    test('a card read that fails is the load error, not a donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAcFails = true
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('plan load failed')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
    })

    test('leaving the card removes the donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardAc[CARD.id] = ac(1, 2)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 50)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await text(band)).not.toMatch(/%|[○◔◑◕]/)
    })
  })
}
