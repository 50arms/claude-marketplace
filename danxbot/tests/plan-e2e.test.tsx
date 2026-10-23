import "./run-tests-with-npm-test.generated"
// DX-4232 E2E: one whole operator session per surface through the real hooks module with a
// stand-in danx-dashboard MCP server: the band at session start counts the open problems as links and writes nothing to a card.
import { describe, expect } from 'claude-code/testing'

import { test, AGENT_NAME, SURFACES, answerPlanConnect, bandLabelOf, dashboard, expectIndicator, footerText, holdAgent, mountIndicator, linksOf, pressFooter, problemBadgeOf, startSession, forceRefresh } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`end to end on ${surface}`, () => {
    test('band, the open problems as a link, the plan page as a link', async ($, on) => {
      const d = dashboard(on)
      d.world.cards[1]!.problems.push({
        id: 23,
        type: 'action',
        statement: 'Rotate the key',
        open: true,
      })
      await startSession($, d, surface)

      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
      expect(await problemBadgeOf(band)).toBe('⚠ 4')
      await expectIndicator(band, surface, 25)
      expect((await linksOf(band)).map(l => l.key)).toEqual(['open-plan', 'open-problems'])
      // nothing the band does writes to a card
      expect(d.writes()).toEqual([])
    })
  })
}

// DX-4374: the indicator flow, end to end on both surfaces.
for (const surface of SURFACES) {
  describe(`the indicator flow on ${surface}`, () => {
    test('connected, dismiss, one footer press restores the band, the listener degrades, disconnect', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      await holdAgent($, d)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const footer = await mountIndicator($, surface, ['focus'])
      expect(await footerText(footer)).toBe(`${AGENT_NAME} · PLAN-23`)
      await expectIndicator(band, surface, 25)
      expect(await band.find({ type: 'Text', text: /^events: / })).toBeUndefined()

      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      await pressFooter(footer)
      expect(await band.find({ key: 'disconnect' })).toBeDefined()

      d.setListener('unattached')
      await forceRefresh($, d)
      expect((await band.find({ type: 'Text', text: /^events: / }))?.text).toBe('events: unattached')

      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      // the session still holds its agent: the footer names the agent alone
      expect(await footerText(footer)).toBe(AGENT_NAME)
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await band.find({ type: 'Text', text: /^events: / })).toBeUndefined()
      expect(await text(band)).not.toMatch(/events|%/)
    })
  })
}
