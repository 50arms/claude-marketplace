import "./run-tests-with-npm-test.generated"
// DX-4609 (PLAN-23 G-1): the band counts the plan's cards that need a person and links the count to the plan's Needs You tab. Every interaction
// with a problem is in the browser, so the band never writes to a card.
import { describe, expect } from 'claude-code/testing'

import { test, SURFACES, bandLabelOf, dashboard, forceRefresh, needsYouBadgeOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

async function openBand($: any, on: any, surface: (typeof SURFACES)[number], options: any = {}) {
  const d = dashboard(on, options)
  await startSession($, d, surface)
  const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
  return { d, band }
}

for (const surface of SURFACES) {
  describe(`open problems on ${surface}`, () => {
    test('the band counts the cards that need a person, and a refresh re-reads the count', async ($, on) => {
      const { d, band } = await openBand($, on, surface)
      expect(await needsYouBadgeOf(band)).toBe('⚠ 2 cards need you')
      for (const c of d.world.cards) for (const p of c.problems) p.open = false
      await forceRefresh($, d)
      expect(await needsYouBadgeOf(band)).toBeUndefined()
    })

    test('the badge counts the cards that need a person, not their problems: 3 open problems on 2 cards read 2', async ($, on) => {
      const { d, band } = await openBand($, on, surface)
      expect(d.world.cards.reduce((n: number, c: any) => n + c.problems.filter((p: any) => p.open).length, 0)).toBe(3)
      expect(await needsYouBadgeOf(band)).toBe('⚠ 2 cards need you')
    })

    test('one card that needs a person reads in the singular', async ($, on) => {
      const { d, band } = await openBand($, on, surface)
      d.world.cards[1]!.problems = []
      await forceRefresh($, d)
      expect(await needsYouBadgeOf(band)).toBe('⚠ 1 card needs you')
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
      expect(await bandLabelOf(band)).toBe('PLAN-23 · Danxbot plugin')
    })
  })
}
