// DX-4374: the footer is ONE button: `PLAN-NN` when a plan is known, `Plan` otherwise, and one press (the same
// function as /danx-plan) brings the band back and opens the Plan pane.
import { describe, expect, test } from 'claude-code/testing'

import { FOOTER_PAD, SURFACES, dashboard, footerText, mountIndicator, startSession, toldModel } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const counts = (o: Record<string, number>) => ({ 'In Progress': 0, ToDo: 0, Backlog: 0, Review: 0, Done: 0, Cancelled: 0, ...o })
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`the footer on ${surface}`, () => {
    test('connected and ready: exactly one Button, key footer-plan, reading PLAN-23; no Svg and no Text of its own', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface, ['focus & memory paused'])
      expect((await footer.findAll({ type: 'Button' })).map((b: any) => [b.key, b.text.replace(FOOTER_PAD, '')])).toEqual([['footer-plan', 'Danxbot · PLAN-23']])
      expect((await footer.find({ key: 'footer-plan' }))?.props.plain).toBe(true)
      // DX-4420: the desktop's native chip takes no padding prop, so its label carries one non-breaking space each side
      const raw = (await footer.find({ key: 'footer-plan' }))?.text
      expect(raw).toBe(surface === 'desktop' ? ' Danxbot · PLAN-23 ' : 'Danxbot · PLAN-23')
      expect(await footer.find({ type: 'Svg' })).toBeUndefined()
      // the only Text is the engine's own mode label, which survives beside the button
      expect(await text(footer)).toBe('focus & memory paused')
    })

    test('not connected: the button reads Danxbot', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface)
      expect((await footer.findAll({ type: 'Button' })).map((b: any) => b.text.replace(FOOTER_PAD, ''))).toEqual(['Danxbot'])
    })

    for (const [name, options] of [
      ['0%', { breakdown: counts({ ToDo: 4 }) }],
      ['50%', { breakdown: counts({ Done: 1, ToDo: 1 }) }],
      ['100%', { breakdown: counts({ Done: 5, Cancelled: 1 }) }],
      ['a capped 3+ load', { cardsTotal: 9 }],
    ] as const) {
      test(`${name}: the text is still exactly Danxbot · PLAN-23 (no percent, glyph or open count)`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot · PLAN-23')
      })
    }

    // the label is derived from view.connected alone: an error built before the plan was read names none
    for (const [name, options, label] of [
      ['a plan-list 500', { listFails: true }, 'Danxbot'],
      ['a thrown MCP call (timeout)', { mcp: 'flaky' }, 'Danxbot'],
      ['a bad dashboard_url', { dashboardUrl: 'not a url' }, 'Danxbot'],
      ['a missing status_breakdown', { noBreakdown: true }, 'Danxbot'],
      ['a failed in-progress call (after the plan was read)', { inProgressFails: true }, 'Danxbot · PLAN-23'],
      ['an in-progress call with no total (after the plan was read)', { noInProgressTotal: true }, 'Danxbot · PLAN-23'],
    ] as const) {
      test(`${name}: the button reads ${label}, never error text`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        expect(await footerText(await mountIndicator($, surface))).toBe(label)
      })
    }

    test('with no danx-dashboard MCP server the site is untouched', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface, ['focus'])
      expect(await footer.find({ key: 'footer-plan' })).toBeUndefined()
      expect(await text(footer)).toBe('focus')
    })

    for (const [name, options] of [
      ['connected', {}],
      ['not connected', { connected: false }],
      ['an error view', { listFails: true }],
    ] as const) {
      test(`a press from ${name} clears dismissed and opens the pane; it tells the model nothing and toasts nothing`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        const footer = await mountIndicator($, surface)
        await footer.press({ key: 'footer-plan' })
        await d.clock.settle()
        expect(d.opened).toEqual([{ id: 'danx-plan', title: 'Danxbot Plan', focus: true }])
        expect(d.stateWrites.filter(w => w.key === 'dismissed').map(w => w.value)).toEqual([false])
        expect(d.toasts).toEqual([])
        expect(toldModel(d)).toEqual([])
        expect(d.writes()).toEqual([])
      })
    }

    test('on a dismissed band one press brings the band back AND opens the pane; a second press hides and closes nothing', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const footer = await mountIndicator($, surface)
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan', 'danx-plan'])
      expect(d.opened.map(o => o.focus)).toEqual([true, true])
      expect(d.stateWrites.filter(w => w.key === 'dismissed').map(w => w.value)).toEqual([true, false, false])
    })

    test('/danx-plan and the footer press are one function: the same state writes and the same open call', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface)
      await footer.press({ key: 'footer-plan' })
      const footerWrites = d.stateWrites.filter(w => w.key === 'dismissed')
      const footerOpened = [...d.opened]

      d.stateWrites.length = 0
      d.opened.length = 0
      await $.command.run({ command: 'danx-plan' })
      await d.clock.settle()
      expect(d.stateWrites.filter(w => w.key === 'dismissed')).toEqual(footerWrites)
      expect(d.opened).toEqual(footerOpened)
      // both opened the pane with focus
      expect(d.opened).toEqual([{ id: 'danx-plan', title: 'Danxbot Plan', focus: true }])
    })
  })
}
