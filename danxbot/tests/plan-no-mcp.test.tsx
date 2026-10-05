// DX-4547 AC 1: a session with no danx-dashboard connection never shows a blank band or footer.
import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_URL, FOOTER_PAD, SURFACES, dashboard, mountIndicator, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const DEFAULT_PLANS = 'https://danxbot.sageus.ai/plans'
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`no danx-dashboard MCP on ${surface}`, () => {
    test('band: says not available, why, the next step, Panel and close stay, both links go to the default origin', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const t = await texts(band)
      expect(t).toContain('Danxbot: not available in this session')
      expect(t).toContain('No danx-dashboard connection in this folder')
      const keys = (await band.findAll({ type: 'Button' })).map((b: any) => b.key)
      expect(keys).toEqual(surface === 'desktop' ? ['open-pane', 'open-tab', 'band-close'] : ['open-pane', 'band-close'])
      expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toEqual([DEFAULT_PLANS])
      if (surface === 'desktop') {
        await band.press({ key: 'open-tab' })
        expect(d.calls.filter((c: any) => c.server === 'Claude_Browser' && c.tool === 'navigate').map((c: any) => c.args.url)).toEqual([DEFAULT_PLANS])
      }
    })

    test('band: the remembered origin wins over the default', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.setMcp('down')
      await d.clock.advance(60_000)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await texts(band)).toContain('not available in this session')
      expect((await band.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toEqual([`${DASHBOARD_URL}/plans`])
    })

    test('footer reads Danxbot · off', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface)
      expect((await footer.findAll({ type: 'Button' })).map((b: any) => b.text.replace(FOOTER_PAD, ''))).toEqual(['Danxbot · off'])
    })

    test('pane says the same', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const t = await texts(pane)
      expect(t).toContain('Danxbot: not available in this session')
      expect(t).toContain('No danx-dashboard connection in this folder')
    })
  })
}
