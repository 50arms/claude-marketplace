// DX-4232 E2E: one whole operator session per surface through the real hooks module with a
// stand-in danx-dashboard MCP server: band at session start -> open pane -> Connect -> the pane lists the open problems as links
// and writes nothing to a card.
import { describe, expect, test } from 'claude-code/testing'

import { NEXT_STEP, SURFACES, dashboard, expectIndicator, expectRowCarries, footerText, mountIndicator, linksOf, problemBadgeOf, startSession, toldModel, forceRefresh } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`end to end on ${surface}`, () => {
    test('band, pane, connect, the open problems as links', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.cards[1]!.problems.push({
        id: 23,
        type: 'action',
        statement: 'Rotate the key',
        open: true,
      })
      await startSession($, d, surface)

      // 1. the band is there with no command typed
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(band)).toContain('Danxbot: not connected to a plan')

      // 2. the Plan button opens the pane
      await band.press({ key: 'open-pane' })
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('Not connected to a plan')

      // 3. Connect binds the session, the band turns green, the model is told
      await pane.press({ key: 'connect' })
      await d.clock.settle()
      expect(d.calls.filter(c => c.tool === 'plan_connect').map(c => c.args.plan_id)).toEqual([23])
      expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
      expect(await problemBadgeOf(band)).toBe('⚠ 4')
      await expectIndicator(band, surface, 25)
      expect(toldModel(d)).toHaveLength(1)

      // 4. the pane lists each open problem as a link into the browser; the band counts them
      const links = (await linksOf(pane)).map(l => l.label).filter(l => / · /.test(l))
      expect(links).toEqual(['DX-1 · Which route?', 'DX-1 · Allow the site', 'DX-2 · Second one?', 'DX-2 · Rotate the key'])
      // nothing in the pane writes to a card; the model was told only of the connect
      expect(d.writes()).toEqual([])
      expect(toldModel(d)).toHaveLength(1)
      expectRowCarries(toldModel(d)[0]!, ['PLAN-23', 'plan_id 23'])
    })
  })
}

// DX-4374: the indicator flow, end to end on both surfaces.
for (const surface of SURFACES) {
  describe(`the indicator flow on ${surface}`, () => {
    test('connect, dismiss, one footer press restores the band and opens the pane with donut and event line, the listener degrades, disconnect', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const footer = await mountIndicator($, surface, ['focus'])
      expect(await footerText(footer)).toBe('Danxbot')

      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      await pane.press({ key: 'connect' })
      await d.clock.settle()
      expect(await footerText(footer)).toBe('Danxbot · PLAN-23')
      await expectIndicator(band, surface, 25)

      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])

      const all = await text(pane)
      expect(all).toContain('25%')
      expect(all).toContain('4 / 16 done')
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeDefined()
      expect((await linksOf(pane)).map(l => l.label)).toContain('DX-9')

      d.setListener('unattached')
      await forceRefresh($, d)
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
      expect(await text(pane)).toContain(NEXT_STEP('unattached'))

      await pane.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(await footerText(footer)).toBe('Danxbot')
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await pane.find({ type: 'Svg' })).toBeUndefined()
      expect(await text(pane)).not.toMatch(/events|%/)
    })
  })
}
