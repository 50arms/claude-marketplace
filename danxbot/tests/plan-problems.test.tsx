import "./run-tests-with-npm-test.generated"
// DX-4609 (PLAN-23 G-1): the band counts the plan's open problems and links the count to the plan's Needs You tab. Every interaction
// with a problem is in the browser, so the band never writes to a card.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, dashboard, forceRefresh, problemBadgeOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

async function openBand($: any, on: any, surface: (typeof SURFACES)[number], options: any = {}) {
  const d = dashboard(on, options)
  await startSession($, d, surface)
  const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
  return { d, band }
}

for (const surface of SURFACES) {
  describe(`open problems on ${surface}`, () => {
    test('the band counts the open problems, and a refresh re-reads the count', async ($, on) => {
      const { d, band } = await openBand($, on, surface)
      expect(await problemBadgeOf(band)).toBe('⚠ 3')
      for (const c of d.world.cards) for (const p of c.problems) p.open = false
      await forceRefresh($, d)
      expect(await problemBadgeOf(band)).toBeUndefined()
    })

    test('the band offers no control to answer, reject or comment', async ($, on) => {
      const { band } = await openBand($, on, surface)
      expect(await band.findAll({ type: 'Input' })).toEqual([])
      const keys = (await band.findAll({ type: 'Button' })).map((b: any) => b.key)
      // a button per problem would end its key in the problem's id
      expect(keys.filter((k: string) => /-\d+$/.test(k))).toEqual([])
    })
  })

  describe(`what one load reads, on ${surface}`, () => {
    test('a plan beyond the plan list cap still labels correctly, from the session in the same response', async ($, on) => {
      const { band } = await openBand($, on, surface, { planOutsideList: true })
      const label = await band.find({ type: 'Text', text: /PLAN-23/ })
      expect(label?.text).toBe('PLAN-23 · Danxbot plugin')
    })
  })
}
