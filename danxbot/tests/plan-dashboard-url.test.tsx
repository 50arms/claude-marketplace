// DX-4317: every link the band and the pane draw is built on the origin the plan list
// answered (`dashboard_url`), never on a constant; an answer without a usable origin is an error state.
import { describe, expect, test } from 'claude-code/testing'

import { NO_DASHBOARD_URL, SURFACES, browserCalls, dashboard, linksOf, footerText, mountIndicator, startSession } from './plan-kit'

const OTHER = 'https://plans.example.test'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const hrefs = async (ui: any) => (await linksOf(ui)).map(l => l.href)

for (const surface of SURFACES) {
  // the default origin's hrefs are asserted in the band, pane and browser-tab tests
  for (const origin of [OTHER]) {
    describe(`links on ${surface}, dashboard at ${origin}`, () => {
      test('the band line links to the plan on that origin', async ($, on) => {
        const d = dashboard(on, { dashboardUrl: origin })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        expect(await hrefs(band)).toEqual([`${origin}/plans/23?tab=needs-you`, `${origin}/plans/23`])
      })

      test('the pane links the plan, every in-progress card and every problem on that origin', async ($, on) => {
        const d = dashboard(on, { dashboardUrl: origin })
        await startSession($, d, surface)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        const found = await hrefs(pane)
        expect(found).toContain(`${origin}/plans/23`)
        expect(found).toContain(`${origin}/plans/23/cards/DX-9`)
        expect(found).toContain(`${origin}/plans/23/cards/DX-1/problems/PBLM-11`)
        expect(found).toContain(`${origin}/plans/23/cards/DX-2/problems/PBLM-21`)
        expect(found.filter(h => !h.startsWith(`${origin}/`))).toEqual([])
      })
    })
  }
}

for (const surface of SURFACES) {
  describe(`the page links of the band and the pane are built on the session dashboard, on ${surface}`, () => {
    test('the Open plan links go to the answered origin and the plugin calls no browser tool', async ($, on) => {
      const d = dashboard(on, { dashboardUrl: OTHER })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect((await linksOf(band)).find(l => l.key === 'open-tab')?.href).toBe(`${OTHER}/plans/23`)
      expect((await linksOf(pane)).find(l => l.key === 'open-plan')?.href).toBe(`${OTHER}/plans/23`)
      expect(browserCalls(d)).toEqual([])
    })
  })
}

describe('an origin the plugin can use', () => {
  test('a trailing slash or path on dashboard_url is dropped: links are built on the origin only', async ($, on) => {
    const d = dashboard(on, { dashboardUrl: `${OTHER}/some/path/` })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await hrefs(band)).toEqual([`${OTHER}/plans/23?tab=needs-you`, `${OTHER}/plans/23`])
  })
})

for (const surface of SURFACES) {
  describe(`an answer without a usable dashboard_url is an error state, with no fallback origin, on ${surface}`, () => {
    for (const [name, value] of [
      ['absent', NO_DASHBOARD_URL],
      ['null', null],
      ['empty', ''],
      ['not a string', 5555],
      ['not a URL', 'localhost:5555 please'],
      ['not http(s)', 'ftp://plans.example.test'],
    ] as const) {
      test(`${name}: the band says error, draws no link and the footer reads Plan`, async ($, on) => {
        const d = dashboard(on, { dashboardUrl: value })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        const footer = await mountIndicator($, surface)
        expect(await footerText(footer)).toBe('Danxbot')
        expect(await linksOf(band)).toEqual([])
        expect(await band.find({ key: 'open-tab' })).toBeUndefined()
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect((await pane.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')).toContain('dashboard_url')
      })
    }

    test('it also fails when the session is not connected to a plan (the field belongs to the list)', async ($, on) => {
      const d = dashboard(on, { dashboardUrl: NO_DASHBOARD_URL, connected: false })
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface)
      expect(await footerText(footer)).toBe('Danxbot')
    })
  })
}
