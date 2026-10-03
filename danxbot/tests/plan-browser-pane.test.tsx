// The Browser pane's three states, with the Claude_Browser results as the desktop app really words
// them: a JSON object FOLLOWED BY PROSE. A closed pane has no tabs and tabs_create is not the way
// in: navigate with no tabId opens the pane at the URL and names the tab it used.
import { describe, expect, test } from 'claude-code/testing'

import { firstJsonObject, navigatedTabId, parseTabId, parseTabsContext } from '../hooks/plan/browser-output'
import { TABS_CREATE_CLOSED, TABS_CREATE_OPEN, dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const URL = 'https://danxbot.sageus.ai/plans/23'
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')
const tools = (d: any) => browserCalls(d).map((c: any) => c.tool)

// captured from the desktop app (2026-10-03)
const CLOSED = `{
  "browserOpen": false,
  "tabs": []
}
The Browser pane isn't open yet, so there are no tabs. Call preview_start or navigate with {"url": "https://…"} to open it.`
const OPEN = `{
  "browserOpen": true,
  "tabs": [
    {
      "tabId": "seed",
      "origin": "https://danxbot.sageus.ai",
      "isActive": true
    }
  ]
}
The Browser pane is currently displayed.`
const NAVIGATED = `navigated to https://danxbot.sageus.ai/plans/23

Tab Context:
- Executed on tabId: seed
- Available tabs:
  • tabId seed: "50 Arms" ("https://danxbot.sageus.ai/plans/23")`

describe('reading the browser tool results', () => {
  test('trailing prose never breaks parsing; the pane closed is a valid answer with no tabs', () => {
    expect(parseTabsContext(CLOSED)).toEqual({ browserOpen: false, tabs: [] })
    expect(parseTabsContext(OPEN)).toEqual({ browserOpen: true, tabs: [{ id: 'seed', isActive: true }] })
    // prose with braces of its own after the object is ignored
    expect(firstJsonObject('{"a": "}"} then {"b": 1}')).toBe('{"a": "}"}')
  })

  test('a result that is not a tab list throws, naming what it was', () => {
    expect(() => parseTabsContext('Tabs: one, two')).toThrow(/no JSON/)
    expect(() => parseTabsContext('{"tabs": []}')).toThrow(/no browserOpen/)
    expect(() => parseTabsContext('{"browserOpen": true}')).toThrow(/no tabs list/)
    expect(() => parseTabsContext('{"browserOpen": tru')).toThrow(/no JSON/)
  })

  test('every tab entry needs a string tabId', () => {
    expect(() => parseTabsContext('{"browserOpen": true, "tabs": [{"origin": "x"}]}')).toThrow(/listed a tab with no tabId/)
    expect(() => parseTabsContext('{"browserOpen": true, "tabs": [{"tabId": 7}]}')).toThrow(/listed a tab with no tabId/)
    expect(() => parseTabsContext('{"browserOpen": true, "tabs": [null]}')).toThrow(/listed a tab with no tabId/)
  })

  test('tabs_create: the id comes from the JSON object only; the pane-closed prose throws', () => {
    expect(parseTabId(TABS_CREATE_OPEN)).toBe('tab-1')
    expect(() => parseTabId(TABS_CREATE_CLOSED)).toThrow(/no tabId/)
    expect(() => parseTabId('Created.\ntabId: tab-9')).toThrow(/no tabId/)
  })

  test('navigate names the tab it used on its "Executed on tabId" line, else it throws', () => {
    expect(navigatedTabId(NAVIGATED)).toBe('seed')
    expect(() => navigatedTabId('navigated to x')).toThrow(/Executed on tabId/)
  })
})

describe('Open in browser tab by pane state, on the desktop', () => {
  test('pane CLOSED: navigate with no tabId opens it and names the tab to keep: two browser calls, no tabs_create', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })

    expect(tools(d)).toEqual(['tabs_context', 'navigate'])
    expect(browserCalls(d)[1].args).toEqual({ url: URL })
    expect(d.stateWrites.filter(w => w.key === 'tab')).toEqual([{ plugin: 'danxbot', key: 'tab', value: 'seed' }])
    expect(d.toasts).toEqual(['Opening the plan in the browser…', 'Plan opened in the browser tab'])
  })

  test('pane closed, then a second press: one tab was opened and the second press reuses it', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    d.calls.length = 0
    await band.press({ key: 'open-tab' })

    expect(tools(d)).toEqual(['tabs_context', 'navigate', 'tabs_select'])
    expect(browserCalls(d)[1].args).toEqual({ url: URL, tabId: 'seed' })
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(1)
  })

  test('pane OPEN and our tab still listed: navigate and select that tab', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    // the first press adopts nothing of the person's: it creates the plugin's own tab
    await band.press({ key: 'open-tab' })
    d.calls.length = 0
    await band.press({ key: 'open-tab' })
    expect(tools(d)).toEqual(['tabs_context', 'navigate', 'tabs_select'])
    expect(browserCalls(d)[1].args).toEqual({ url: URL, tabId: 'tab-7' })
  })

  test('pane OPEN and no tab of ours: tabs_create, navigate, select, keep its id', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'] })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(tools(d)).toEqual(['tabs_context', 'tabs_create', 'navigate', 'tabs_select'])
    expect(browserCalls(d)[2].args).toEqual({ url: URL, tabId: 'tab-7' })
    expect(d.stateWrites.filter(w => w.key === 'tab')).toEqual([{ plugin: 'danxbot', key: 'tab', value: 'tab-7' }])
  })

  test('tabs_context says open but tabs_create answers the pane-closed text: toast, no tab kept, no navigate', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'], tabsCreate: 'closed' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(tools(d)).toEqual(['tabs_context', 'tabs_create'])
    expect(d.toasts.at(-1)).toMatch(/^Browser tabs_create failed: use the link instead\. \(tabs_create answered no tabId: No tab was created/)
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
  })

  test('a tabs_context entry with no tabId is a toast, never a guess', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'], badTabEntry: true })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(tools(d)).toEqual(['tabs_context'])
    expect(d.toasts.at(-1)).toMatch(/^Browser tabs_context failed: use the link instead\. \(tabs_context listed a tab with no tabId/)
  })

  test('a failure while opening a closed pane toasts the advice first and never cuts a sentence', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, browser: 'denied' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(d.toasts.at(-1)).toBe('Browser navigate failed: use the link instead. (navigation to this site is not allowed)')
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
  })
})
