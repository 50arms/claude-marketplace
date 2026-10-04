// DX-4374: the Plan pane header carries the progress donut with its percent and done / total: a real Svg on the
// desktop, the glyph and the same figures as text on the terminal.
import { describe, expect, test } from 'claude-code/testing'

import { DONUT_PANE_PX } from '../hooks/plan/config'
import { donutGlyph, doneTotal } from '../hooks/plan/words'
import { SURFACES, dashboard, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const counts = (o: Record<string, number>) => ({ 'In Progress': 0, ToDo: 0, Backlog: 0, Review: 0, Done: 0, Cancelled: 0, ...o })
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

describe('doneTotal is the percent rule', () => {
  test('Done over In Progress + ToDo + Backlog + Review + Done; Cancelled excluded', () => {
    expect(doneTotal(counts({ 'In Progress': 3, ToDo: 5, Backlog: 1, Review: 3, Done: 4, Cancelled: 2 }) as any)).toEqual({ done: 4, total: 16 })
    expect(doneTotal(counts({ Cancelled: 4 }) as any)).toEqual({ done: 0, total: 0 })
  })
})

for (const surface of SURFACES) {
  describe(`the pane's progress on ${surface}`, () => {
    test('connected and ready: the donut, 25% and 4 / 16 done', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const all = await texts(pane)
      expect(all).toContain('25%')
      expect(all).toContain('4 / 16 done')
      const svgs = await pane.findAll({ type: 'Svg' })
      if (surface === 'desktop') {
        expect(svgs.map((s: any) => [s.props.alt, s.props.width, s.props.height])).toEqual([['25% complete', DONUT_PANE_PX, DONUT_PANE_PX]])
        expect(all).not.toContain('◔')
      } else {
        expect(svgs).toHaveLength(0)
        expect(all).toContain('◔')
      }
    })

    for (const [name, breakdown, percent, done] of [
      ['0%', counts({ ToDo: 4 }), 0, '0 / 4 done'],
      ['50%', counts({ Done: 1, ToDo: 1 }), 50, '1 / 2 done'],
      ['100%', counts({ Done: 5, Cancelled: 1 }), 100, '5 / 5 done'],
      ['a Cancelled-only plan', counts({ Cancelled: 3 }), 0, '0 / 0 done'],
    ] as const) {
      test(`${name}: ${percent}% and ${done}, never NaN`, async ($, on) => {
        const d = dashboard(on, { breakdown })
        await startSession($, d, surface)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        const all = await texts(pane)
        expect(all).toContain(`${percent}%`)
        expect(all).toContain(done)
        expect(all.join(' ')).not.toMatch(/NaN%|NaN \//)
        if (surface === 'desktop') expect((await pane.find({ type: 'Svg' }))?.props.alt).toBe(`${percent}% complete`)
        else expect(all).toContain(donutGlyph(percent))
      })
    }

    test('the percent appears once in the pane', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect((await texts(pane)).join(' | ').match(/25%/g)).toHaveLength(1)
    })

    for (const [name, options] of [
      ['a plan-list error', { listFails: true }],
      ['a missing status_breakdown', { noBreakdown: true }],
      ['a failed in-progress call', { inProgressFails: true }],
      ['not connected', { connected: false }],
    ] as const) {
      test(`${name}: no donut, percent or done / total`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect(await pane.find({ type: 'Svg' })).toBeUndefined()
        expect((await texts(pane)).join(' | ')).not.toMatch(/%|\d+ \/ \d+ done/)
      })
    }

    test('a loading view draws no donut', async ($, on) => {
      const d = dashboard(on, { hangFirstLoad: true })
      await $.session.start({ cwd: '/work', surface, isInteractive: true })
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await pane.find({ type: 'Svg' })).toBeUndefined()
      expect((await texts(pane)).join(' | ')).toContain('Loading')
      await d.clock.advance(3_600_000)
    })
  })
}
