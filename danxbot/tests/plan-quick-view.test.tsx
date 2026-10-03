// DX-4346: the quick view (a card in the band, opened from the footer entry) and the dismissable band.
import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, footerText, mountIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

async function mounted($: any, d: any, surface: string, modes: string[] = []) {
  await startSession($, d, surface)
  const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
  const footer = await mountIndicator($, surface, modes)
  return { band, footer }
}

for (const surface of SURFACES) {
  describe(`the quick view on ${surface}`, () => {
    test('a press on the footer entry opens it; a second press, or its close control, closes it', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'quick-view' })).toBeDefined()
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()
      await footer.press({ key: 'footer-plan' })
      await band.press({ key: 'quick-close' })
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()
      // the band line itself is still there
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
    })

    test('it carries ref, name, status, percent, the six counts, problems and actions apart, in progress, listener and links', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      const quick = await text(band)
      expect(quick).toContain('PLAN-23 · Danxbot plugin')
      expect(quick).toContain('building · 25% complete')
      expect(quick).toContain('In Progress 3 · ToDo 5 · Backlog 1 · Review 3 · Done 4 · Cancelled 2')
      // 2 questions and 1 action: counted separately
      expect(quick).toContain('2 open problems')
      expect(quick).toContain('1 action')
      // the bucket's own count, labelled as such, never under the status label
      expect(quick).toContain('1 in progress, not waiting on you')
      expect(quick).toContain('events live')
      // the band's own link and the quick view's, both the one plan URL
      expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toEqual(Array(2).fill('https://danxbot.sageus.ai/plans/23'))
      expect(await band.find({ key: 'quick-open-pane' })).toBeDefined()
    })

    test('the desktop draws a real Svg donut about 44 px; the terminal the glyph and percent as text', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      const svgs = await band.findAll({ type: 'Svg' })
      if (surface === 'desktop') {
        expect(svgs.map((s: any) => [s.props.width, s.props.alt])).toEqual([
          [16, '25% complete'],
          [44, '25% complete'],
        ])
      } else {
        expect(svgs).toHaveLength(0)
        expect(await band.find({ key: 'quick-view' })).toBeDefined()
        expect(await text(band)).toContain('25% complete')
      }
    })

    test('the Browser tab button exists on the desktop only and goes through the one open handler', async ($, on) => {
      const d = dashboard(on, { browserClosed: true, navigateTakesMs: 5_000 })
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      const button = await band.find({ key: 'quick-open-tab' })
      if (surface === 'terminal') {
        expect(button).toBeUndefined()
        return
      }
      expect(button?.text).toBe('Browser tab')
      const opening = band.press({ key: 'quick-open-tab' })
      await d.clock.settle()
      // the same busy state the band's own button shows
      expect((await band.find({ key: 'quick-open-tab' }))?.text).toBe('Opening…')
      expect((await band.find({ key: 'open-tab' }))?.text).toBe('Opening…')
      await d.clock.advance(5_000)
      await opening
      expect(d.calls.filter(c => c.server === 'Claude_Browser').map(c => c.tool)).toEqual(['tabs_context', 'preview_start'])
    })

    test('the Plan button opens the pane', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      await band.press({ key: 'quick-open-pane' })
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
    })

    test('a /clear closes it (transient) and keeps the plan connected', async ($, on) => {
      const d = dashboard(on)
      on('session.end', () => ({ sessionId: 's1' }) as any)
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      await $.session.end({ reason: 'clear' } as any)
      await d.clock.settle()
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
    })

    test('not connected: there is no quick view, the press opens the pane', async ($, on) => {
      const d = dashboard(on, { connected: false })
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
    })
  })

  describe(`the quick view in an error state on ${surface}`, () => {
    test('a failed card read removes it, with no guessed zeros and no donut; the next good refresh brings it back', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'quick-view' })).toBeDefined()

      d.failInProgress()
      await d.clock.advance(60_000)
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()
      expect(await text(band)).toContain('plan: error')
      expect(await text(band)).not.toMatch(/0 open problems|0 actions|0 in progress/)
      expect(await band.find({ type: 'Svg' })).toBeUndefined()
      expect(await footerText(footer)).toBe('plan: error')

      // quickOpen survived the error: the next good refresh draws the card again
      d.failInProgress(false)
      await d.clock.advance(60_000)
      expect(await band.find({ key: 'quick-view' })).toBeDefined()
      expect(await footerText(footer)).toBe('◔ 25% · PLAN-23 · 3 open')
    })

    test('leaving or changing plan closes it for good; the dismissed flag is not reset', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await footer.press({ key: 'footer-plan' })
      d.world.planId = null
      await d.clock.advance(60_000)
      d.world.planId = 23
      await d.clock.advance(60_000)
      // reconnected: the card does not come back by itself
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()

      await footer.press({ key: 'footer-plan' })
      d.world.planId = 24
      await d.clock.advance(60_000)
      expect(await band.find({ key: 'quick-view' })).toBeUndefined()

      await band.press({ key: 'band-close' })
      d.world.planId = null
      await d.clock.advance(60_000)
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
    })
  })

  describe(`dismissing the band on ${surface}`, () => {
    test('the close control hides the band; the footer entry brings it back in one press, with the quick view open', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      expect(await band.find({ key: 'band-close' })).toBeDefined()
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      // the footer is untouched by the dismissal
      expect((await footer.find({ key: 'footer-plan' }))?.text).toContain('PLAN-23')

      await footer.press({ key: 'footer-plan' })
      expect(await band.find({ key: 'open-pane' })).toBeDefined()
      expect(await band.find({ key: 'quick-view' })).toBeDefined()
    })

    test('a second dismiss after a restore works; closing the band also closes the quick view', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await footer.press({ key: 'footer-plan' })
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'open-pane' })).toBeUndefined()
      await footer.press({ key: 'footer-plan' })
      // the quick view was closed with the band, so this restore opens it again (the band was dismissed)
      expect(await band.find({ key: 'quick-view' })).toBeDefined()
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

    test('the dismissed flag and the quick-view flag are $.state atoms under plugin danxbot, not part of the view', async ($, on) => {
      const d = dashboard(on)
      const { band, footer } = await mounted($, d, surface)
      await band.press({ key: 'band-close' })
      await footer.press({ key: 'footer-plan' })
      const keys = new Set(d.stateWrites.map(w => `${w.plugin}.${w.key}`))
      expect(keys.has('danxbot.dismissed')).toBe(true)
      expect(keys.has('danxbot.quickOpen')).toBe(true)
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
      expect(keys).toEqual(surface === 'desktop' ? ['open-pane', 'open-tab', 'band-close'] : ['open-pane', 'band-close'])
      expect(await band.find({ type: 'Link' })).toBeDefined()
      expect((await band.find({ key: 'band-close' }))?.props.role).toBe('dismiss')
    })
  })
}
