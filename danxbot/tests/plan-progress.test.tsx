// DX-4346: the plan-progress figure and the footer entry that carries it. The footer (the
// SessionMode site) draws text buttons only, so it shows a text glyph on both surfaces; the Svg donut
// lives in the band line and the quick view.
import { describe, expect, test } from 'claude-code/testing'

import { donutGlyph, planPercent } from '../hooks/plan/words'
import { SURFACES, dashboard, expectIndicator, footerText, mountIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const counts = (o: Record<string, number>) => ({ 'In Progress': 0, ToDo: 0, Backlog: 0, Review: 0, Done: 0, Cancelled: 0, ...o })
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

describe('the percent mirrors the dashboard (PlanStatusSummary.tsx, DX-3766)', () => {
  // Done / (In Progress + ToDo + Backlog + Review + Done), Cancelled excluded, Backlog included, Math.round
  const TABLE: [string, Record<string, number>, number][] = [
    ['0 cards', {}, 0],
    ['only Cancelled', { Cancelled: 4 }, 0],
    ['1 of 8 is 13 (12.5 rounds up)', { Done: 1, ToDo: 7 }, 13],
    ['1 of 3 is 33', { Done: 1, Review: 2 }, 33],
    ['2 of 3 is 67', { Done: 2, 'In Progress': 1 }, 67],
    ['all Done is 100', { Done: 6 }, 100],
    ['Backlog only is 0', { Backlog: 5 }, 0],
    ['Backlog counts in the total', { Done: 1, Backlog: 1 }, 50],
    ['adding Cancelled changes nothing', { Done: 1, ToDo: 3, Cancelled: 9 }, 25],
  ]
  for (const [name, input, percent] of TABLE) {
    test(name, () => {
      expect(planPercent(counts(input) as any)).toBe(percent)
      expect(Number.isNaN(planPercent(counts(input) as any))).toBe(false)
    })
  }

  test('the glyph bands cover every integer', () => {
    for (let p = 0; p <= 100; p++) {
      const g = donutGlyph(p)
      expect(g).toBe(p === 0 ? '○' : p <= 37 ? '◔' : p <= 62 ? '◑' : p < 100 ? '◕' : '●')
    }
  })
})

for (const surface of SURFACES) {
  describe(`the progress figure on ${surface}`, () => {
    test('it is read from the connected plan by id, even when that plan is outside the capped list', async ($, on) => {
      const d = dashboard(on, { planOutsideList: true })
      await startSession($, d, surface)
      expect(d.api.some(a => a.path === '/api/plans/23')).toBe(true)
      expect(await footerText(await mountIndicator($, surface))).toBe('◔ 25% · PLAN-23 · 3 open')
    })

    for (const [name, options] of [
      ['no status_breakdown at all', { noBreakdown: true }],
      ['a status key missing', { breakdown: { 'In Progress': 1, ToDo: 1, Backlog: 0, Review: 0, Done: 1 } }],
    ] as const) {
      test(`${name} is a named error: no guessed 0%`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        expect(await footerText(await mountIndicator($, surface))).toBe('plan: error')
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect(await text(pane)).toContain('status_breakdown')
      })
    }

    test('a status count that is not a number is the same error', async ($, on) => {
      const d = dashboard(on, { breakdown: { ...counts({ Done: 1 }), Review: '3' } })
      await startSession($, d, surface)
      expect(await footerText(await mountIndicator($, surface))).toBe('plan: error')
    })

    for (const [breakdown, label] of [
      [counts({ ToDo: 4 }), '○ 0% · PLAN-23 · 3 open'],
      [counts({ Done: 1, ToDo: 1 }), '◑ 50% · PLAN-23 · 3 open'],
      [counts({ Done: 3, ToDo: 1 }), '◕ 75% · PLAN-23 · 3 open'],
      [counts({ Done: 5, Cancelled: 1 }), '● 100% · PLAN-23 · 3 open'],
    ] as const) {
      test(`the footer entry is a TEXT glyph and percent, no Svg: ${label}`, async ($, on) => {
        const d = dashboard(on, { breakdown })
        await startSession($, d, surface)
        const footer = await mountIndicator($, surface)
        expect(await footerText(footer)).toBe(label)
        expect(await footer.find({ type: 'Svg' })).toBeUndefined()
      })
    }

    test('the band line draws the donut: an Svg whose alt carries N% complete on the desktop, the glyph on the terminal', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await expectIndicator(band, surface, 25)
    })

    test('a complete plan draws the done mark: alt 100% complete on the desktop, the text 100% on the terminal', async ($, on) => {
      const d = dashboard(on, { breakdown: counts({ Done: 4 }) })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await expectIndicator(band, surface, 100)
      expect(await footerText(await mountIndicator($, surface))).toBe('● 100% · PLAN-23 · 3 open')
    })

    test('not connected: the footer reads not connected, the band draws no donut, a press opens the pane', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface)
      expect(await footerText(footer)).toBe('plan: not connected')
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await text(band)).not.toMatch(/%/)
      await footer.press({ key: 'footer-plan' })
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
    })

    test('with no danx-dashboard MCP server the footer draws nothing of its own and shows no error', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface, ['focus'])
      expect(await footer.find({ key: 'footer-plan' })).toBeUndefined()
      expect(await text(footer)).toBe('focus')
    })

    test('the engine\'s own mode labels survive beside the plan entry', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface, ['focus', 'memory paused'])
      expect(await text(footer)).toBe('focus & memory paused')
      expect(await footerText(footer)).toBe('◔ 25% · PLAN-23 · 3 open')
    })

    test('no $.ui.status call remains: the footer entry replaced it (R-1)', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      await pane.press({ key: 'connect' })
      await d.clock.settle()
      await d.clock.advance(60_000)
      d.failList()
      await d.clock.advance(60_000)
      expect(d.statuses).toHaveLength(0)
    })
  })
}
