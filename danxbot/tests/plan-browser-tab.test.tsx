import { describe, expect, test } from 'claude-code/testing'

import { dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const URL = 'https://danxbot.sageus.ai/plans/23'
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')

describe('Open in browser tab', () => {
  test('the tab id lives in $.state; the second press reuses that tab and navigates no other', async ($, on) => {
    // the person already has a tab of their own
    const d = dashboard(on, { tabs: ['tab-1'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })

    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_create', 'navigate', 'tabs_select'])
    expect(browserCalls(d)[2].args).toEqual({ url: URL, tabId: 'tab-7' })
    expect(d.stateWrites.filter(w => w.key === 'tab')).toEqual([{ plugin: 'danxbot', key: 'tab', value: 'tab-7' }])

    d.calls.length = 0
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'open-plan' })
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'navigate', 'tabs_select'])
    for (const call of browserCalls(d).filter((c: any) => c.tool !== 'tabs_context')) expect(call.args.tabId).toBe('tab-7')
    expect(d.toasts).toHaveLength(0)
  })

  test('a held tab that was closed is replaced, never a neighbour navigated', async ($, on) => {
    const d = dashboard(on, { tabs: ['tab-1'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    d.closeTabs()
    d.calls.length = 0
    await band.press({ key: 'open-tab' })
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_create', 'navigate', 'tabs_select'])
  })

  // This test must stay AFTER the first one in this file: that test leaves tab-7 held in its own
  // session, and here a new session finds tab-7 in the browser but not in its own $.state. A tab id
  // kept in a module variable would be shared across the two and reused.
  test('a fresh session holds no tab: nothing is shared through the module', async ($, on) => {
    const d = dashboard(on, { tabs: ['tab-7'] })
    await startSession($, d, 'desktop')
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    // tab-7 exists in the browser but is not ours: a tab is created
    expect(browserCalls(d).map((c: any) => c.tool)).toContain('tabs_create')
  })

  test('a denied navigation says so and points at the link', async ($, on) => {
    const d = dashboard(on, { browser: 'denied' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(d.toasts).toHaveLength(1)
    expect(d.toasts[0]).toMatch(/navigate was denied or failed: navigation to this site is not allowed/)
    expect(d.toasts[0]).toMatch(/Use the link instead\.$/)
    expect(browserCalls(d).map((c: any) => c.tool)).not.toContain('tabs_select')
  })

  for (const mode of ['error', 'garbage'] as const) {
    test(`a ${mode} tabs_context goes to the toast: no tab is created or navigated`, async ($, on) => {
      const d = dashboard(on, { tabs: ['tab-1'], tabsContext: mode })
      await startSession($, d, 'desktop')
      const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
      await band.press({ key: 'open-tab' })
      await band.press({ key: 'open-tab' })
      expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'tabs_context'])
      expect(d.toasts).toHaveLength(2)
      expect(d.toasts[0]).toMatch(/Browser tabs_context was denied or failed: .*Use the link instead\.$/)
      expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
    })
  }

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
