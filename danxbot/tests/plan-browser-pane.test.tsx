// The Browser pane's three states, with the Claude_Browser results as the desktop app really words
// them: a JSON object FOLLOWED BY PROSE. A closed pane has no tabs and tabs_create is not the way
// in: navigate with no tabId opens the pane at the URL and names the tab it used.
import { describe, expect, test } from 'claude-code/testing'

import { firstJsonObject, parsePreviewStart, parseTabId, parseTabsContext } from '../hooks/plan/browser-output'
import {
  DASHBOARD_URL,
  PREVIEW_START_OK,
  TABS_CONTEXT_CLOSED,
  TABS_CONTEXT_CLOSED_LATER,
  TABS_CREATE_CLOSED,
  TABS_CREATE_OPEN,
  dashboard,
  startSession,
} from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const URL = `${DASHBOARD_URL}/plans/23`
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')
const tools = (d: any) => browserCalls(d).map((c: any) => c.tool)

// captured from the desktop app (2026-10-03); the kit holds the closed ones
const CLOSED = TABS_CONTEXT_CLOSED
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

  test('both closed answers of tabs_context read as the pane closed', () => {
    expect(parseTabsContext(TABS_CONTEXT_CLOSED)).toEqual({ browserOpen: false, tabs: [] })
    expect(parseTabsContext(TABS_CONTEXT_CLOSED_LATER)).toEqual({ browserOpen: false, tabs: [] })
  })

  test('preview_start: the tab id comes from its JSON, and navOk must be true', () => {
    expect(parsePreviewStart(PREVIEW_START_OK)).toBe('seed')
    expect(() => parsePreviewStart(PREVIEW_START_OK.replace('"navOk": true', '"navOk": false'))).toThrow(/navOk is not true/)
    expect(() => parsePreviewStart(PREVIEW_START_OK.replace('"navOk": true', '"other": 1'))).toThrow(/navOk is not true/)
    expect(() => parsePreviewStart(PREVIEW_START_OK.replace('"tabId": "seed"', '"x": 1'))).toThrow(/no tabId/)
    expect(() => parsePreviewStart('Browser pane opened.')).toThrow(/no JSON/)
  })
})

describe('Open in browser tab by pane state, on the desktop', () => {
  for (const closedText of ['not-yet-open', 'not-open'] as const) {
    test(`pane CLOSED (${closedText}): tabs_context then preview_start, nothing else; the tab it names is kept`, async ($, on) => {
      const d = dashboard(on, { browserClosed: true, closedText })
      await startSession($, d, 'desktop')
      const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
      await band.press({ key: 'open-tab' })

      expect(tools(d)).toEqual(['tabs_context', 'preview_start'])
      expect(browserCalls(d)[1].args).toEqual({ url: URL })
      expect(d.stateWrites.filter(w => w.key === 'tab')).toEqual([{ plugin: 'danxbot', key: 'tab', value: 'seed' }])
      expect(d.toasts).toEqual(['Opening the plan in the browser…', 'Plan opened in the browser tab'])
    })
  }

  test('preview_start with navOk false toasts the excerpt and stores nothing', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, previewStart: 'navNotOk' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(tools(d)).toEqual(['tabs_context', 'preview_start'])
    expect(d.toasts.at(-1)).toMatch(/^Browser preview_start failed: use the link instead\. \(preview_start did not load the page \(navOk is not true\): /)
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
  })

  test('a rejected preview_start call says so with the rejection text, and never falls back to navigate', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, previewStart: 'rejected' })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(tools(d)).toEqual(['tabs_context', 'preview_start'])
    expect(d.toasts.at(-1)).toMatch(/^Browser preview_start failed: use the link instead\. \(.*preview_start is not available to plugins/)
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
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
    expect(d.toasts.at(-1)).toBe('Browser preview_start failed: use the link instead. (navigation to this site is not allowed)')
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(0)
  })
})
