import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, expectText, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any

describe('plan band', () => {
  test('shows Not connected and a Plan button with no command typed, on every surface', async ($, on) => {
    const d = dashboard(on, { connected: false })
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expectText(await ui.find({ type: 'Text', text: /Not connected to a plan/ }), /Not connected to a plan/)
      expect(await ui.find({ type: 'Button', key: 'open-pane' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('connected: ref, name and the open-problem count; Browser tab only on the desktop, the link on both', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expectText(await ui.find({ type: 'Text', text: /PLAN-23/ }), /PLAN-23 · Danxbot plugin · 3 open problems/)
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      const tab = await ui.find({ type: 'Button', key: 'open-tab' })
      if (surface === 'desktop') expect(tab).toBeDefined()
      else expect(tab).toBeUndefined()
      await ui.unmount()
    }
  })

  test('without the danx-dashboard MCP server the band is only a Plan button and shows no error', async ($, on) => {
    const d = dashboard(on, { mcp: 'down' })
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const ui = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(b => b.key)).toEqual(['open-pane', 'band-close'])
      expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
      await ui.unmount()
    }
    expect(d.statuses).toHaveLength(0)
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
