// The loading state of Open in browser tab: a slow open reads "Opening…" on every browser-open
// button until the final step resolves, a second press meanwhile makes no second open, and the key
// is released on success and on failure.
import { describe, expect, test } from 'claude-code/testing'

import { dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const browserCalls = (d: any) => d.calls.filter((c: any) => c.server === 'Claude_Browser')
const label = async (ui: any, key: string) => (await ui.find({ key }))?.text

async function mounted($: any, d: any) {
  await startSession($, d, 'desktop')
  const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
  const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
  return { band, pane }
}

describe('Open in browser tab shows it is working', () => {
  for (const press of [
    { from: 'band', key: 'open-tab' },
    { from: 'pane', key: 'open-plan' },
  ] as const) {
    test(`pressed on the ${press.from} (${press.key}): every browser button reads Opening… while the open is in flight, then flips back`, async ($, on) => {
      const d = dashboard(on, { browserClosed: true, navigateTakesMs: 5_000 })
      const { band, pane } = await mounted($, d)
      expect(await label(band, 'open-tab')).toBe('Browser tab')
      expect(await label(pane, 'open-plan')).toBe('Open in browser tab')

      const ui = press.from === 'band' ? band : pane
      const opening = ui.press({ key: press.key })
      await d.clock.settle()
      expect(await label(band, 'open-tab')).toBe('Opening…')
      expect(await label(pane, 'open-plan')).toBe('Opening…')
      expect(d.toasts).toEqual(['Opening the plan in the browser…'])

      await d.clock.advance(5_000)
      await opening
      expect(await label(band, 'open-tab')).toBe('Browser tab')
      expect(await label(pane, 'open-plan')).toBe('Open in browser tab')
      expect(d.toasts).toEqual(['Opening the plan in the browser…', 'Plan opened in the browser tab'])
    })
  }

  test('a second press while the open is in flight makes no second browser call, from any button', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, navigateTakesMs: 5_000 })
    const { band, pane } = await mounted($, d)
    const first = band.press({ key: 'open-tab' })
    await d.clock.settle()
    const calls = browserCalls(d).length
    await Promise.all([band.press({ key: 'open-tab' }), pane.press({ key: 'open-plan' })])
    expect(browserCalls(d)).toHaveLength(calls)
    expect(d.toasts.filter(t => t.startsWith('Opening'))).toHaveLength(1)
    await d.clock.advance(5_000)
    await first
    // one open: tabs_context + preview_start, and the tab was kept once
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_context', 'preview_start'])
    expect(d.stateWrites.filter(w => w.key === 'tab')).toHaveLength(1)
  })

  // DX-4424: a navigate costs ~2.5-3.5 s in the host whatever the page is, so the open ends when the
  // tab is in front and the page loads on its own.
  test('pane open with our tab: the buttons flip back and the toast says opened when the tab is in front, not when the page has loaded', async ($, on) => {
    const d = dashboard(on, { tabs: ['seed'], navigateTakesMs: 5_000 })
    const { band, pane } = await mounted($, d)
    await band.press({ key: 'open-tab' })
    await d.clock.advance(5_000)
    await d.clock.settle()
    d.calls.length = 0
    d.toasts.length = 0

    await band.press({ key: 'open-tab' })
    expect(browserCalls(d).map((c: any) => c.tool)).toEqual(['tabs_select', 'navigate'])
    // the navigate is still running on the clock, and nothing waits on it
    expect(d.toasts).toEqual(['Opening the plan in the browser…', 'Plan opened in the browser tab'])
    expect(await label(band, 'open-tab')).toBe('Browser tab')
    expect(await label(pane, 'open-plan')).toBe('Open in browser tab')

    await d.clock.advance(5_000)
    await d.clock.settle()
    expect(d.toasts).toHaveLength(2)
  })

  test('a failing step releases the key: the label returns, the failure toast shows, the next press opens again', async ($, on) => {
    const d = dashboard(on, { browserClosed: true, browser: 'denied' })
    const { band } = await mounted($, d)
    await band.press({ key: 'open-tab' })
    expect(await label(band, 'open-tab')).toBe('Browser tab')
    expect(d.toasts).toEqual([
      'Opening the plan in the browser…',
      'Browser preview_start failed: use the link instead. (navigation to this site is not allowed)',
    ])
    const calls = browserCalls(d).length
    await band.press({ key: 'open-tab' })
    expect(browserCalls(d).length).toBeGreaterThan(calls)
    expect(await label(band, 'open-tab')).toBe('Browser tab')
  })

  test('the short toasts carry a short timeout, not the default', async ($, on) => {
    const d = dashboard(on, { browserClosed: true })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await band.press({ key: 'open-tab' })
    expect(d.toastTimeouts).toEqual([2_500, 2_500])
  })

  test('the terminal has the link only: no button to show a loading state on', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'terminal')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'terminal', ...BAND })
    expect(await band.find({ key: 'open-tab' })).toBeUndefined()
    expect(await band.find({ type: 'Link' })).toBeDefined()
  })
})
