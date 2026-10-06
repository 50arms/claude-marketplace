// DX-4521: the band always offers both links (the in-app browser and the default browser): the plan's page when connected,
// else the dashboard's plans list.
import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_URL, NO_DASHBOARD_URL, SURFACES, dashboard, startSession, forceRefresh } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PLANS = `${DASHBOARD_URL}/plans`
const PLAN = `${PLANS}/23`
const browserUrls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser' && c.tool === 'navigate').map((c: any) => c.args.url)

// The two links as the band draws them: the external one is a Link on every surface, the in-app one a Button on the desktop.
async function links(ui: any, surface: string) {
  const hrefs = (await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href as string)
  const tab = await ui.find({ type: 'Button', key: 'open-tab' })
  return { external: hrefs.filter((h: string) => !h.includes('?tab=')), inApp: surface === 'desktop' ? tab !== undefined : null }
}

for (const surface of SURFACES) {
  describe(`band links on ${surface}`, () => {
    test('connected: both go to the plan', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await links(band, surface)).toEqual({ external: [PLAN], inApp: surface === 'desktop' ? true : null })
      if (surface === 'desktop') {
        await band.press({ key: 'open-tab' })
        expect(browserUrls(d)).toEqual([PLAN])
      }
    })

    test('not connected to a plan: both go to the plans list', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await links(band, surface)).toEqual({ external: [PLANS], inApp: surface === 'desktop' ? true : null })
      if (surface === 'desktop') {
        await band.press({ key: 'open-tab' })
        expect(browserUrls(d)).toEqual([PLANS])
      }
    })

    test('no event listener: both links stay', async ($, on) => {
      const d = dashboard(on, { listener: 'no_listener' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await links(band, surface)).toEqual({ external: [PLAN], inApp: surface === 'desktop' ? true : null })
    })

    for (const state of ['lapsed', 'revoked'] as const) {
      test(`${state}: the origin last seen stands in, so both go to the plans list`, async ($, on) => {
        const d = dashboard(on)
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        d.world.signedOut = state
        await forceRefresh($, d)
        expect(await links(band, surface)).toEqual({ external: [PLANS], inApp: surface === 'desktop' ? true : null })
      })
    }

    test('a failed load keeps both links on the plans list', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.failList()
      await forceRefresh($, d)
      expect(await links(band, surface)).toEqual({ external: [PLANS], inApp: surface === 'desktop' ? true : null })
    })

    test('an origin never seen leaves out the links: there is no address to open', async ($, on) => {
      const d = dashboard(on, { dashboardUrl: NO_DASHBOARD_URL })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await links(band, surface)).toEqual({ external: [], inApp: surface === 'desktop' ? false : null })
    })
  })
}
