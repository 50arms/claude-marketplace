import "./run-tests-with-npm-test.generated"
// DX-4521 / DX-4630 / DX-5605: the band's page link is the plan id (`PLAN-23`) beside the donut, going to the plan's page. There is no Open plan control: with no
// plan connected the band names none, so it draws no page link. It is a Markdown link on every surface, so the app opens it in the in-app browser as it opens a
// link in the thread; the plugin makes no browser tool call. The open-problem count's link is separate (its own Needs You URL).
import { describe, expect } from 'claude-code/testing'

import { test, DASHBOARD_URL, NO_DASHBOARD_URL, SURFACES, browserCalls, dashboard, forceRefresh, linksOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PLAN = `${DASHBOARD_URL}/plans/23`

// the page links the band draws, apart from the open-problem count's
async function pageLinks(ui: any) {
  expect(await ui.findAll({ type: 'Link' })).toEqual([])
  expect(await ui.findAll({ type: 'Button', key: 'open-tab' })).toEqual([])
  return (await linksOf(ui)).filter(l => l.key !== 'needs-you')
}

for (const surface of SURFACES) {
  describe(`band links on ${surface}`, () => {
    test('connected: the plan id is the one link to the plan, and nothing reads Open plan', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await pageLinks(band)).toEqual([{ key: 'open-plan', label: 'PLAN-23', href: PLAN }])
      expect(JSON.stringify(await band.drawn())).not.toContain('Open plan')
      expect(browserCalls(d)).toEqual([])
    })

    test('not connected to a plan: the band names none and draws no page link', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await pageLinks(band)).toEqual([])
    })

    test('no event listener: the link stays', async ($, on) => {
      const d = dashboard(on, { listener: 'no_listener' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect((await pageLinks(band)).map(l => l.href)).toEqual([PLAN])
    })

    for (const state of ['lapsed', 'revoked'] as const) {
      test(`${state}: the band names no plan, so it draws no page link`, async ($, on) => {
        const d = dashboard(on)
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        d.world.signedOut = state
        await forceRefresh($, d)
        expect(await pageLinks(band)).toEqual([])
      })
    }

    test('a failed load names no plan: no page link', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.failList()
      await forceRefresh($, d)
      expect(await pageLinks(band)).toEqual([])
    })

    test('an origin never seen leaves out the link: there is no address to open', async ($, on) => {
      const d = dashboard(on, { dashboardUrl: NO_DASHBOARD_URL })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await pageLinks(band)).toEqual([])
    })
  })
}
