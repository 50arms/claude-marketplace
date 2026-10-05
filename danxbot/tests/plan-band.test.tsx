import { describe, expect, test } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { bandLabel } from '../hooks/plan/words'
import { DASHBOARD_URL, SURFACES, problemBadgeOf, dashboard, expectText, footerText, mountIndicator, startSession } from './plan-kit'

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

  test('the band cuts the name to the columns its controls leave, never a control', async ($, on) => {
    const d = dashboard(on, { planName: 'A very long plan name that goes on and on and on' })
    await startSession($, d, 'desktop')
    const wide = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 200 } } as any)
    const narrow = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 70 } } as any)
    const labelOf = async (ui: any) => (await ui.find({ type: 'Text', text: /PLAN-23/ }))?.text as string
    expect(await labelOf(wide)).toBe('PLAN-23 · A very long plan name that goes on and on and on')
    // 70 columns less the indicator, two gaps, 2 spare, and the controls: Panel 10, `⚠ 3` 8, Browser tab 16, Open ↗ 7, × 6
    expect(await labelOf(narrow)).toBe('PLAN-23 · A very…')
    expect((await narrow.find({ key: 'open-pane' }))?.text).toBe('Panel')
  })

  test('the first load reads Danxbot Plan: loading…', () => {
    expect(bandLabel({ ...EMPTY, phase: 'loading', refreshedAt: null })).toBe('Danxbot Plan: loading…')
  })

  test('shows Not connected and a Plan button with no command typed, on every surface', async ($, on) => {
    const d = dashboard(on, { connected: false })
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expectText(await ui.find({ type: 'Text', text: /Danxbot: not connected to a plan/ }), /Danxbot: not connected to a plan/)
      expect(await ui.find({ type: 'Button', key: 'open-pane' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the open-problem count is a call-to-action button on the desktop and a link on the terminal, both to the Needs You tab', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await problemBadgeOf(ui)).toBe('⚠ 3')
      const button = await ui.find({ type: 'Button', key: 'open-problems' })
      if (surface === 'desktop') expect(button).toBeDefined()
      else expect(button).toBeUndefined()
      if (surface === 'terminal') expect((await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain(`${DASHBOARD_URL}/plans/23?tab=needs-you`)
      await ui.unmount()
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

  test('connected: ref, name and the open-problem count; Browser tab only on the desktop, the link on both', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expectText(await ui.find({ type: 'Text', text: /PLAN-23/ }), /^PLAN-23 · Danxbot plugin$/)
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      const tab = await ui.find({ type: 'Button', key: 'open-tab' })
      if (surface === 'desktop') expect(tab).toBeDefined()
      else expect(tab).toBeUndefined()
      await ui.unmount()
    }
  })

  test('without the danx-dashboard MCP server the band says it is not available (DX-4547) and shows no error', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => b.key)).toContain('open-pane')
      expect(buttons.map(b => b.key)).toContain('band-close')
      expect((await ui.findAll({ type: 'Text' })).map((t: any) => t.text)[0]).toBe('Danxbot: not available in this session')
      await ui.unmount()
    }
    expect(d.statuses.filter(s => s !== undefined)).toEqual([])
  })

  test('yields to a survey', async ($, on) => {
    const d = dashboard(on)
    // a survey keeps the band to itself: the plugin passes, so only the engine's own (here empty) tree is drawn
    await startSession($, d, 'desktop')
    const ui = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: true } } as any)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.find({ key: 'open-pane' })).toBeUndefined()
    // and without a survey the same band draws
    const free = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
    expect(await free.find({ key: 'open-pane' })).toBeDefined()
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
    test('the close control hides the band; one footer press brings it back and opens the pane', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      expect(await band.find({ key: 'band-close' })).toBeDefined()
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      // the footer is untouched by the dismissal
      expect(await footerText(footer)).toBe('Danxbot · PLAN-23')

      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
    })

    test('a second dismiss after a restore works', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await footer.press({ key: 'footer-plan' })
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
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
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      expect(d.stateWrites.filter(w => w.key === 'dismissed' && w.value === false)).toHaveLength(0)
    })

    test('/danx-plan brings a dismissed band back (a keyboard way)', async ($, on) => {
      const d = dashboard(on)
      const { band } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await $.command.run({ command: 'danx-plan' })
      await d.clock.settle()
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
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
      await footer.press({ key: 'footer-plan' })
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
      const controlsAt = kids.findIndex((c: any) => c?.type === 'Box' && c.props.flexShrink === 0 && c.children?.some((x: any) => x?.props?.key === 'open-pane'))
      expect(labelAt).toBeGreaterThan(-1)
      expect(spacerAt).toBeGreaterThan(labelAt)
      expect(controlsAt).toBeGreaterThan(spacerAt)
      expect((await band.find({ type: 'Text', text: /PLAN-23/ }))?.props.wrap).toBe('truncate-end')
      // order and keys unchanged, the close control last
      const keys = (await band.findAll({ type: 'Button' })).map((b: any) => b.key)
      expect(keys).toEqual(surface === 'desktop' ? ['open-pane', 'open-problems', 'open-tab', 'band-close'] : ['open-pane', 'band-close'])
      expect(await band.find({ type: 'Link' })).toBeDefined()
      expect((await band.find({ key: 'band-close' }))?.props.role).toBe('dismiss')
    })
  })
}
