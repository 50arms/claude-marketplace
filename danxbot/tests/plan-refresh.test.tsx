import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const label = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')

for (const surface of SURFACES) {
  describe(`60 s refresh on ${surface}`, () => {
    test('loads the needs-you cards on session start, then again every 60 s on the clock, with no real sleep', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await label(band)).toContain('3 open problems')
      expect(d.statuses.at(-1)).toBe('plan: PLAN-23 · 3 open problems')

      // a new problem appears on the dashboard; the next tick of the clock picks it up
      d.world.cards[1]!.problems.push({ id: 22, type: 'question', statement: 'New?', open: true, solutions: [] })
      const loads = d.api.filter(a => a.path === '/api/plans').length
      await d.clock.advance(59_000)
      expect(d.api.filter(a => a.path === '/api/plans')).toHaveLength(loads)
      await d.clock.advance(1_000)
      expect(d.api.filter(a => a.path === '/api/plans')).toHaveLength(loads + 1)
      expect(await label(band)).toContain('4 open problems')
      expect(d.statuses.at(-1)).toBe('plan: PLAN-23 · 4 open problems')
    })

    test('a refresh error shows `plan: error` in the band and the message in the pane', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      d.failList()
      await d.clock.advance(60_000)
      expect(await label(band)).toContain('plan: error')
      expect(d.statuses.at(-1)).toBe('plan: error')
      expect(await label(pane)).toContain('500: boom')
      // and it recovers on the next good load
      d.failList(false)
      await d.clock.advance(60_000)
      expect(await label(band)).toContain('3 open problems')
    })

    test('the Refresh button forces a load every press', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const loads = () => d.api.filter(a => a.path === '/api/plans').length
      const start = loads()
      // the Refresh button forces; two presses are two loads
      await pane.press({ key: 'refresh' })
      await pane.press({ key: 'refresh' })
      expect(loads()).toBe(start + 2)
    })
  })
}

describe('state keys', () => {
  test('everything the plugin keeps is under the plugin key danxbot; no plan-link key remains', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'open-11' })
    expect(d.stateWrites.length).toBeGreaterThan(0)
    expect([...new Set(d.stateWrites.map(w => w.plugin))]).toEqual(['danxbot'])
  })
})
