import "./run-tests-with-npm-test.generated"
import { describe, expect } from 'claude-code/testing'

import { DISCONNECT_GLYPH, EMPTY } from '../hooks/plan/config'
import { bandLabel } from '../hooks/plan/words'
import { test, AGENT_NAME, DASHBOARD_URL, SURFACES, answerPlanConnect, bandLabelOf, browserCalls, linksOf, problemBadgeOf, dashboard, expectText, footerText, holdAgent, mountIndicator, pressFooter, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

describe('plan band', () => {
  test('the full plan name shows with no width limit; with one it is cut with an ellipsis only when it overflows', () => {
    const connected = (name: string) => ({ ...EMPTY, phase: 'ready' as const, connected: { ...(EMPTY as any).connected, ref: 'PLAN-17', name, id: 17, dashboardUrl: 'x' } })
    const long = 'x'.repeat(80)
    expect(bandLabel(connected(long) as any)).toBe(`PLAN-17 · ${long}`)
    expect(bandLabel(connected(long) as any, 30)).toBe(`PLAN-17 · ${'x'.repeat(19)}…`)
    expect(bandLabel(connected('short') as any, 30)).toBe('PLAN-17 · short')
    expect(bandLabel(connected(long) as any, 3)).toBe('PLAN-17 · xxx…')
  })

  test('the terminal band cuts the name to the columns its controls leave, never a control', async ($, on) => {
    const d = dashboard(on, { planName: 'A very long plan name that goes on and on and on' })
    await startSession($, d, 'terminal')
    const wide = await $.ui.mount({ plugin: 'danxbot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 200 } } as any)
    const narrow = await $.ui.mount({ plugin: 'danxbot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 70 } } as any)
    expect(await bandLabelOf(wide)).toBe('PLAN-23 · A very long plan name that goes on and on and on')
    // 70 columns less the indicator, two gaps, 2 spare, and the controls: the Disconnect glyph, `⚠ 3` 8, × 6 (the glyph is narrower than the word, so the name keeps more)
    expect(await bandLabelOf(narrow)).toBe('PLAN-23 · A very long plan name that goes o…')
    expect((await narrow.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
  })
  test('DX-4626: the desktop band never pre-cuts the name by a column count; the layout truncates it beside the controls', async ($, on) => {
    const d = dashboard(on, { planName: 'A very long plan name that goes on and on and on' })
    await startSession($, d, 'desktop')
    const narrow = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 70 } } as any)
    expect(await bandLabelOf(narrow)).toBe('PLAN-23 · A very long plan name that goes on and on and on')
    expect((await narrow.find({ type: 'Text', text: / · / }))?.props.wrap).toBe('truncate-end')
    expect((await narrow.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
  })


  test('the first load reads 50 Arms: loading…', () => {
    expect(bandLabel({ ...EMPTY, phase: 'loading', refreshedAt: null })).toBe('50 Arms: loading…')
  })

  test('shows Not connected and a close control with no command typed, on every surface', async ($, on) => {
    const d = dashboard(on, { connected: false })
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expectText(await ui.find({ type: 'Text', text: /50 Arms: not connected to a plan/ }), /50 Arms: not connected to a plan/)
      expect(await ui.find({ type: 'Button', key: 'band-close' })).toBeDefined()
      expect(await ui.find({ key: 'disconnect' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the open-problem count is a Markdown link to the Needs You tab on every surface, never a Button or a Link element', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await problemBadgeOf(ui)).toBe('⚠ 3')
      expect(await ui.find({ type: 'Button', key: 'open-problems' })).toBeUndefined()
      expect(await ui.findAll({ type: 'Link' })).toEqual([])
      expect((await linksOf(ui)).find(l => l.key === 'open-problems')?.href).toBe(`${DASHBOARD_URL}/plans/23?tab=needs-you`)
      await ui.unmount()
      expect(browserCalls(d)).toEqual([])
    }
  })

  test('a plan with no open problems draws no problem button or link', async ($, on) => {
    const d = dashboard(on)
    for (const card of d.world.cards) card.problems = []
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await problemBadgeOf(ui)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('connected: the open-problem count leads, then the plan id link and the name; no Open plan link, the same on both surfaces', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await bandLabelOf(ui)).toBe('PLAN-23 · Danxbot plugin')
      expect(await ui.findAll({ type: 'Link' })).toEqual([])
      expect(await ui.find({ key: 'open-tab' })).toBeUndefined()
      expect(await linksOf(ui)).toEqual([
        { key: 'open-problems', label: '⚠ 3', href: `${DASHBOARD_URL}/plans/23?tab=needs-you` },
        { key: 'open-plan', label: 'PLAN-23', href: `${DASHBOARD_URL}/plans/23` },
      ])
      expect(JSON.stringify(await ui.findAll({ type: 'Text' }))).not.toContain('Open plan')
      await ui.unmount()
    }
  })

  test('yields to a survey', async ($, on) => {
    const d = dashboard(on)
    // a survey keeps the band to itself: the plugin passes, so only the engine's own (here empty) tree is drawn
    await startSession($, d, 'desktop')
    const ui = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: true } } as any)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.find({ key: 'disconnect' })).toBeUndefined()
    // and without a survey the same band draws
    const free = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
    expect(await free.find({ key: 'disconnect' })).toBeDefined()
  })
})

async function mounted($: any, d: any, surface: string) {
  await startSession($, d, surface)
  const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
  const footer = await mountIndicator($, surface)
  return { band, footer }
}

for (const surface of SURFACES) {
  describe(`dismissing the band on ${surface}`, () => {
    test('the close control hides the band; one footer press brings it back', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      const { band, footer } = await mounted($, d, surface)
      await holdAgent($, d)
      expect(await band.find({ key: 'band-close' })).toBeDefined()
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      // the footer is untouched by the dismissal
      expect(await footerText(footer)).toBe(`${AGENT_NAME} · PLAN-23`)

      await pressFooter(footer)
      expect(await band.find({ key: 'disconnect' })).toBeDefined()
    })

    test('a second dismiss after a restore works', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await pressFooter(footer)
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      await pressFooter(footer)
      expect(await band.find({ key: 'disconnect' })).toBeDefined()
    })

    test('it stays dismissed through a refresh, a second session.start, a /clear and a connection change', async ($, on) => {
      const d = dashboard(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      const { band } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })

      await d.clock.advance(60_000)
      await startSession($, d, surface)
      await $.session.end({ reason: 'clear' } as any)
      await d.clock.settle()
      d.world.planId = null
      await d.clock.advance(60_000)
      d.world.planId = 24
      await d.clock.advance(60_000)
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      expect(d.stateWrites.filter(w => w.key === 'dismissed' && w.value === false)).toHaveLength(0)
    })

    test('/danx-plan brings a dismissed band back (a keyboard way)', async ($, on) => {
      const d = dashboard(on)
      const { band } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await $.command.run({ command: 'danx-plan' })
      await d.clock.settle()
      expect(await band.find({ key: 'disconnect' })).toBeDefined()
    })

    test('a dismissed band with no danx-dashboard MCP server draws nothing', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      const { band } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
    })

    test('the dismissed flag is a $.state atom under plugin danxbot, not part of the view', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await pressFooter(footer)
      expect(new Set(d.stateWrites.map(w => `${w.plugin}.${w.key}`)).has('danxbot.dismissed')).toBe(true)
      expect(d.stateWrites.some(w => w.key === 'view' && JSON.stringify(w.value).includes('dismissed'))).toBe(false)
    })
  })

  describe(`the band line on ${surface}`, () => {
    test('the controls sit after a growing spacer at the right; the label is the one element that truncates', async ($, on) => {
      const d = dashboard(on)
      const { band } = await mounted($, d, surface)
      const tree: any = await band.drawn()
      const row = tree.type === 'Box' && tree.children.some((c: any) => c?.props?.flexGrow === 1) ? tree : null
      expect(row).not.toBeNull()
      const kids = row.children
      const spacerAt = kids.findIndex((c: any) => c?.type === 'Box' && c.props.flexGrow === 1)
      const labelAt = kids.findIndex((c: any) => c?.type === 'Box' && c.props.flexShrink === 1)
      const controlsAt = kids.findIndex((c: any) => c?.type === 'Box' && c.props.flexShrink === 0 && c.children?.some((x: any) => x?.props?.key === 'disconnect'))
      expect(labelAt).toBeGreaterThan(-1)
      expect(spacerAt).toBeGreaterThan(labelAt)
      expect(controlsAt).toBeGreaterThan(spacerAt)
      expect((await band.find({ type: 'Text', text: / · / }))?.props.wrap).toBe('truncate-end')
      // order and keys unchanged, the close control last
      const keys = (await band.findAll({ type: 'Button' })).map((b: any) => b.key)
      expect(keys).toEqual(['disconnect', 'band-close'])
      expect((await linksOf(band)).map(l => l.key)).toEqual(['open-problems', 'open-plan'])
      expect((await band.find({ key: 'band-close' }))?.props.role).toBe('dismiss')
    })
  })
}
