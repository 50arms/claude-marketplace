// DX-4317: every link the band and the pane draw is built on the origin the plan list
// answered (`dashboard_url`), never on a constant; an answer without a usable origin is an error state.
import { describe, expect, test } from 'claude-code/testing'

import { NO_DASHBOARD_URL, SURFACES, dashboard, footerText, mountIndicator, startSession } from './plan-kit'

const OTHER = 'https://plans.example.test'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const hrefs = async (ui: any) => (await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href as string)
const browserUrls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser' && c.tool === 'navigate').map((c: any) => c.args.url)

for (const surface of SURFACES) {
  // the default origin's hrefs are asserted in the band, pane and browser-tab tests
  for (const origin of [OTHER]) {
    describe(`links on ${surface}, dashboard at ${origin}`, () => {
      test('the band line links to the plan on that origin', async ($, on) => {
        const d = dashboard(on, { dashboardUrl: origin })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        expect(await hrefs(band)).toEqual(surface === 'desktop' ? [`${origin}/plans/23`] : [`${origin}/plans/23?tab=needs-you`, `${origin}/plans/23`])
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

describe('the browser-tab buttons open the session dashboard (desktop)', () => {
  test('band, pane and a problem each navigate to the answered origin', async ($, on) => {
    const d = dashboard(on, { dashboardUrl: OTHER, tabs: ['tab-1'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await band.press({ key: 'open-tab' })
    await pane.press({ key: 'open-plan' })
    await pane.press({ key: 'open-11' })
    await pane.press({ key: 'tab-11' })
    expect(browserUrls(d)).toEqual([
      `${OTHER}/plans/23`,
      `${OTHER}/plans/23`,
      `${OTHER}/plans/23/cards/DX-1/problems/PBLM-11`,
    ])
  })
})

describe('an origin the plugin can use', () => {
  test('a trailing slash or path on dashboard_url is dropped: links are built on the origin only', async ($, on) => {
    const d = dashboard(on, { dashboardUrl: `${OTHER}/some/path/` })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await hrefs(band)).toEqual([`${OTHER}/plans/23`])
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
        expect(await band.findAll({ type: 'Link' })).toHaveLength(0)
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
