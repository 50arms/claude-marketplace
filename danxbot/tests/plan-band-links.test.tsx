// DX-4521 / DX-4630: the band's page link (Browser tab) goes to the plan's page when connected, else the dashboard's plans list. It is
// a Markdown link on every surface, so the app opens it in the in-app browser as it opens a link in the thread; the plugin makes no
// browser tool call. The open-problem count's link is separate (its own Needs You URL).
import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_URL, NO_DASHBOARD_URL, SURFACES, browserCalls, dashboard, forceRefresh, linksOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PLANS = `${DASHBOARD_URL}/plans`
const PLAN = `${PLANS}/23`

// the page links the band draws, apart from the open-problem count's
async function pageLinks(ui: any) {
  expect(await ui.findAll({ type: 'Link' })).toEqual([])
  expect(await ui.findAll({ type: 'Button', key: 'open-tab' })).toEqual([])
  return (await linksOf(ui)).filter(l => l.key !== 'open-problems')
}

for (const surface of SURFACES) {
  describe(`band links on ${surface}`, () => {
    test('connected: one Browser tab link to the plan', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await pageLinks(band)).toEqual([{ key: 'open-tab', label: 'Browser tab', href: PLAN }])
      expect(browserCalls(d)).toEqual([])
    })

    test('not connected to a plan: it goes to the plans list', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await pageLinks(band)).toEqual([{ key: 'open-tab', label: 'Browser tab', href: PLANS }])
    })

    test('no event listener: the link stays', async ($, on) => {
      const d = dashboard(on, { listener: 'no_listener' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect((await pageLinks(band)).map(l => l.href)).toEqual([PLAN])
    })

    for (const state of ['lapsed', 'revoked'] as const) {
      test(`${state}: the origin last seen stands in, so it goes to the plans list`, async ($, on) => {
        const d = dashboard(on)
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        d.world.signedOut = state
        await forceRefresh($, d)
        expect((await pageLinks(band)).map(l => l.href)).toEqual([PLANS])
      })
    }

    test('a failed load keeps the link on the plans list', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.failList()
      await forceRefresh($, d)
      expect((await pageLinks(band)).map(l => l.href)).toEqual([PLANS])
    })

    test('an origin never seen leaves out the link: there is no address to open', async ($, on) => {
      const d = dashboard(on, { dashboardUrl: NO_DASHBOARD_URL })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await pageLinks(band)).toEqual([])
    })
  })
}
