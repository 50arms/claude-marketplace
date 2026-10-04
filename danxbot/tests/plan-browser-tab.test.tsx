import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_URL, dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const URL = `${DASHBOARD_URL}/plans/23`
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')

describe('Open in browser tab', () => {
  test('the tab id lives in $.state; the second press reuses that tab and navigates no other', async ($, on) => {
    // the person already has a tab of their own
    const d = dashboard(on, { tabs: ['tab-1'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })

    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_create', 'tabs_select', 'navigate'])
    expect(browserCalls(d)[3].args).toEqual({ url: URL, tabId: 'tab-7' })
    expect(d.stateWrites.filter(w => w.key === 'tab')).toEqual([{ plugin: 'danxbot', key: 'tab', value: 'tab-7' }])

    d.calls.length = 0
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'open-plan' })
    // DX-4424: our tab is fronted first and with no tabs_context before it; the navigate follows
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_select', 'navigate'])
    for (const call of browserCalls(d)) expect(call.args.tabId).toBe('tab-7')
    // two presses, each a start toast and a success toast, and nothing else
    expect(d.toasts).toEqual(Array(2).fill(['Opening the plan in the browser…', 'Plan opened in the browser tab']).flat())
  })

  test('a held tab that was closed is replaced, never a neighbour navigated', async ($, on) => {
    const d = dashboard(on, { tabs: ['tab-1'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    d.closeTabs()
    d.calls.length = 0
    await band.press({ key: 'open-tab' })
    // the held id is refused by tabs_select, so the tabs are re-read and a new tab replaces it
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_select', 'tabs_context', 'tabs_create', 'tabs_select', 'navigate'])
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(2)
  })

  test('a denied navigation says so and points at the link', async ($, on) => {
    const d = dashboard(on, { browser: 'denied' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    await d.clock.settle()
    // the tab came forward, then the page load failed and said so
    expect(d.toasts).toEqual([
      'Opening the plan in the browser…',
      'Plan opened in the browser tab',
      'Browser navigate failed: use the link instead. (navigation to this site is not allowed)',
    ])
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_create', 'tabs_select', 'navigate'])
  })

  for (const mode of ['error', 'garbage'] as const) {
    test(`a ${mode} tabs_context goes to the toast: no tab is created or navigated`, async ($, on) => {
      const d = dashboard(on, { tabs: ['tab-1'], tabsContext: mode })
      await startSession($, d, 'desktop')
      const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
      await band.press({ key: 'open-tab' })
      await band.press({ key: 'open-tab' })
      expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_context'])
      expect(d.toasts).toHaveLength(4)
      expect(d.toasts[1]).toMatch(/^Browser tabs_context failed: use the link instead\. \(.+\)$/)
      expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
    })
  }

  test('pressing the problem count opens the Needs You tab once through the browser-tab path', async ($, on) => {
    const d = dashboard(on, { tabs: ['tab-1'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-problems' })

    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_create', 'tabs_select', 'navigate'])
    expect(browserCalls(d)[3].args).toEqual({ url: `${URL}?tab=needs-you`, tabId: 'tab-7' })
  })

  test('the terminal draws no browser-tab button anywhere, the link only', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'terminal', ...BAND })
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'terminal', ...PANE })
    await pane.press({ key: 'open-11' })
    for (const ui of [band, pane]) {
      for (const key of ['open-tab', 'open-plan', 'tab-11']) expect(await ui.find({ key })).toBeUndefined()
      expect(await ui.find({ type: 'Link' })).toBeDefined()
    }
    expect(browserCalls(d)).toHaveLength(0)
  })
})
