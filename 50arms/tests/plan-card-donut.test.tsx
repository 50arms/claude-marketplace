import "./run-tests-with-npm-test.generated"
// CP-91: a session connected to a card shows the card's checklist progress as the same donut a connected plan shows. The percent is the checklist items passing over all items,
// every checklist of the card together; a card with no items draws none; a card read that cannot be read is the load's named error, never a guessed figure.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, dashboard, expectIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const CARD = { id: 'DX-77', title: 'One-off fix' }
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const items = (...statuses: string[]) => statuses.map((status, i) => ({ id: i + 1, label: `item ${i + 1}`, status }))
const list = (id: number, ...statuses: string[]) => ({ id, name: `list ${id}`, items: items(...statuses) })

for (const surface of SURFACES) {
  describe(`the card donut on ${surface}`, () => {
    test('the checklist progress is read from the held card and drawn as the plan donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [list(1, 'passing', 'incomplete', 'incomplete', 'incomplete')]
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 25)
      if (surface === 'desktop') expect((await band.find({ type: 'Svg' }))?.props.width).toBe(16)
      const read = d.api.find(a => a.method === 'GET' && a.path === '/api/issues/DX-77')
      expect(read?.query).toEqual({ fields: { checklists: true } })
    })

    test('every checklist of the card counts together, rounded to a whole percent', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [list(1, 'passing', 'passing'), list(2, 'incomplete')]
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 67)
    })

    test('every item passing draws the done mark', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [list(1, 'passing', 'passing')]
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 100)
    })

    test('no item passing draws an empty donut, not none', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [list(1, 'incomplete')]
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      await expectIndicator(band, surface, 0)
    })

    test('a card with no checklist items draws no donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [{ id: 1, name: 'empty', items: [] }]
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('One-off fix')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await text(band)).not.toMatch(/%|[○◔◑◕]/)
    })

    test('a card with no checklists at all draws no donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('One-off fix')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
    })

    test('a session holding no card makes no card read and draws no donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = { id: 6, name: 'Tendai', avatar_url: null }
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(d.api.filter(a => a.path.startsWith('/api/issues/'))).toEqual([])
    })

    test('a checklist item with no status is a named error: no guessed figure', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [{ id: 1, name: 'x', items: [{ id: 1, label: 'a' } as any] }]
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('Disconnected')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
    })

    test('a card read that fails is the load error, not a donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklistFails = true
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await text(band)).toContain('Disconnected')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
    })

    test('leaving the card removes the donut', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      d.world.cardChecklists[CARD.id] = [list(1, 'passing', 'incomplete')]
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
