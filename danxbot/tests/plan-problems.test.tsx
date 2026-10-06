// DX-4609 (PLAN-23 G-1): the pane's Needs You is a read-only list, one titled link per open problem, in the dashboard's card-priority
// order. Every interaction with a problem is in the browser, so nothing in the pane writes to a card.
import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_URL, SURFACES, dashboard, forceRefresh, problemBadgeOf, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any

async function openPane($: any, on: any, surface: (typeof SURFACES)[number], options: any = {}) {
  const d = dashboard(on, options)
  await startSession($, d, surface)
  const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
  return { d, pane }
}

const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
// every problem link: the pane's other links go to the plan and to in-progress cards, never to a problem
const problemLinks = async (ui: any) =>
  (await ui.findAll({ type: 'Link' }))
    .map((l: any) => ({ label: l.props.label as string, href: l.props.href as string }))
    .filter((l: { href: string }) => l.href.includes('/problems/'))

for (const surface of SURFACES) {
  describe(`open problems on ${surface}`, () => {
    test('one row per open problem, titled with the card ref and the statement, linking to the problem on its card', async ($, on) => {
      const { pane } = await openPane($, on, surface)
      expect(await problemLinks(pane)).toEqual([
        { label: 'DX-1 · Which route?', href: `${DASHBOARD_URL}/plans/23/cards/DX-1/problems/PBLM-11` },
        { label: 'DX-1 · Allow the site', href: `${DASHBOARD_URL}/plans/23/cards/DX-1/problems/PBLM-12` },
        { label: 'DX-2 · Second one?', href: `${DASHBOARD_URL}/plans/23/cards/DX-2/problems/PBLM-21` },
      ])
    })

    test('the rows follow the dashboard\'s card order, and a refresh re-reads it', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      d.world.cards.reverse()
      await forceRefresh($, d)
      expect((await problemLinks(pane)).map((l: { label: string }) => l.label)).toEqual([
        'DX-2 · Second one?',
        'DX-1 · Which route?',
        'DX-1 · Allow the site',
      ])
    })

    test('the section header counts the open problems, split into actions and questions', async ($, on) => {
      const { pane } = await openPane($, on, surface)
      const t = await text(pane)
      expect(t).toContain('Needs You | 3 open | 1 action | 2 questions')
    })

    test('a long statement is the whole title, never cut', async ($, on) => {
      const long = 'Should the importer keep the legacy column or drop it, given that three downstream reports still read it every night?'
      const { d, pane } = await openPane($, on, surface)
      d.world.cards[0]!.problems[0]!.statement = long
      await forceRefresh($, d)
      expect((await problemLinks(pane))[0]).toMatchObject({ label: `DX-1 · ${long}` })
    })

    test('no open problem: the empty state and no problem link', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      for (const c of d.world.cards) for (const p of c.problems) p.open = false
      await forceRefresh($, d)
      expect(await text(pane)).toContain('Nothing needs you on this plan.')
      expect(await text(pane)).toContain('Needs You | 0 open')
      expect(await problemLinks(pane)).toEqual([])
    })

    test('the pane offers no control to answer, reject or comment, and pressing what it does offer writes nothing to a card', async ($, on) => {
      const { d, pane } = await openPane($, on, surface)
      expect(await pane.findAll({ type: 'Input' })).toEqual([])
      const keys = (await pane.findAll({ type: 'Button' })).map((b: any) => b.key)
      expect(keys).toEqual(expect.arrayContaining(['refresh', 'switch', 'disconnect']))
      expect(keys.filter((k: string) => /^(open|use|note|rej|tick|talk|comment|free)-\d/.test(k))).toEqual([])
      await pane.press({ key: 'refresh' })
      await pane.press({ key: 'switch' })
      await d.clock.settle()
      expect(d.writes()).toEqual([])
    })

    test('the band still counts the open problems', async ($, on) => {
      await openPane($, on, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as any)
      expect(await problemBadgeOf(band)).toBe('⚠ 3')
    })
  })

  describe(`what one load reads, on ${surface}`, () => {
    test('more needs-you cards than were read: the pane says how many are in the browser and the band counts a lower bound', async ($, on) => {
      const { pane } = await openPane($, on, surface, { cardsTotal: 20 })
      expect(await text(pane)).toContain('+18 more cards with open problems in the browser')
      const band = await $.ui.mount({ plugin: 'danxbot', surface, component: 'AbovePrompt', props: { hasSurvey: false } } as any)
      expect(await problemBadgeOf(band)).toBe('⚠ 3+')
    })

    test('a plan beyond the plan list cap still labels correctly, from the session in the same response', async ($, on) => {
      const { pane } = await openPane($, on, surface, { planOutsideList: true })
      const t = await text(pane)
      expect(t).toContain('Connected: PLAN-23')
      expect(t).toContain('Danxbot plugin')
    })
  })
}
