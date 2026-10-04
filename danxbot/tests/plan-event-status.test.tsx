// DX-4374: the Plan pane's event line, beside the plan connection line: a green dot and `events` while the bridge
// is `healthy`, the server's state and next step in the warning colour otherwise, never green without a bridge.
import { describe, expect, test } from 'claude-code/testing'

import { NO_EVENT_BRIDGE } from '../hooks/plan/config'
import { LISTENER_STATES, NEXT_STEP, SURFACES, dashboard, footerText, mountIndicator, startSession } from './plan-kit'

const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const GREEN = 'green'
const YELLOW = 'yellow'
const texts = async (ui: any): Promise<any[]> => ui.findAll({ type: 'Text' })
const joined = async (ui: any) => (await texts(ui)).map((t: any) => t.text).join(' | ')
// the terminal's progress glyph is green too: it is not an event dot
const yellowDots = async (ui: any) => (await texts(ui)).filter((t: any) => t.text === '●' && t.props.color === YELLOW).length
const greens = async (ui: any) => (await texts(ui)).filter((t: any) => t.props.color === GREEN && !/^[○◔◑◕]$/.test(t.text)).map((t: any) => t.text)

for (const surface of SURFACES) {
  describe(`the event line on ${surface}`, () => {
    test('healthy: a success-coloured dot and `events` in one row, no next step, beside the connection line', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      // the connection line's dot is the other green; the event dot is its own Text, in the row with `events`
      expect(await greens(pane)).toEqual(['● Connected: PLAN-23', '●'])
      const events = await pane.find({ type: 'Text', text: /^events$/ })
      expect(events).toBeDefined()
      const all = await joined(pane)
      expect(all).toContain('● Connected: PLAN-23')
      expect(all.indexOf('● Connected: PLAN-23')).toBeLessThan(all.indexOf('events'))
      expect(all).not.toContain('Next step')
      expect(all).not.toContain(NO_EVENT_BRIDGE)
    })

    for (const state of LISTENER_STATES.filter(s => s !== 'healthy')) {
      test(`${state}: the state name and the next step verbatim, in the warning colour, never green`, async ($, on) => {
        const d = dashboard(on, { listener: state })
        await startSession($, d, surface)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        const named = (await texts(pane)).find((t: any) => t.text === `events: ${state}`)
        expect(named?.props.color).toBe(YELLOW)
        expect(await yellowDots(pane)).toBe(1)
        const step = (await texts(pane)).find((t: any) => t.text === NEXT_STEP(state))
        expect(step?.props.color).toBe(YELLOW)
        expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
        expect(await greens(pane)).toEqual(['● Connected: PLAN-23'])
      })
    }

    test('an unknown state string shows as that string in warning with its next step; only `healthy` is green', async ($, on) => {
      const d = dashboard(on, { listener: 'Healthy' })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect((await texts(pane)).find((t: any) => t.text === 'events: Healthy')?.props.color).toBe(YELLOW)
      expect(await joined(pane)).toContain(NEXT_STEP('Healthy'))
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
      expect(await greens(pane)).toEqual(['● Connected: PLAN-23'])
    })

    test('connected with no listener row: a warning line saying so; no green dot, no `events` label', async ($, on) => {
      const d = dashboard(on, { listener: null })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const line = (await texts(pane)).find((t: any) => t.text === NO_EVENT_BRIDGE)
      expect(line?.props.color).toBe(YELLOW)
      expect(await yellowDots(pane)).toBe(1)
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
      expect(await greens(pane)).toEqual(['● Connected: PLAN-23'])
    })

    // the state is the truth, not the `attached` flag: a reader keyed on `attached` would get both of these wrong
    test('attached true with a non-healthy state is the warning line, never green', async ($, on) => {
      const d = dashboard(on, { listener: 'credential_mismatch', attached: true })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect((await texts(pane)).find((t: any) => t.text === 'events: credential_mismatch')?.props.color).toBe(YELLOW)
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
      expect(await greens(pane)).toEqual(['● Connected: PLAN-23'])
    })

    test('attached false with the healthy state is the green line: only the state decides', async ($, on) => {
      const d = dashboard(on, { listener: 'healthy', attached: false })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeDefined()
    })

    // a present-but-unreadable status fails the load like a bad dashboard_url; absent or null is the no-status line
    for (const [name, raw] of [
      ['a state that is not a string', { attached: true, state: 5, nextStep: null }],
      ['a next step that is neither a string nor null', { attached: true, state: 'stopped', nextStep: 7 }],
      ['no nextStep at all', { attached: true, state: 'stopped' }],
      ['a status that is not an object', 'healthy'],
    ] as const) {
      test(`${name}: the load is an error naming sessionListenerAttached, the footer reads Plan, and no event line is drawn`, async ($, on) => {
        const d = dashboard(on, { rawListener: raw })
        await startSession($, d, surface)
        const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
        expect(await joined(pane)).toContain('sessionListenerAttached')
        expect(await joined(pane)).not.toContain(NO_EVENT_BRIDGE)
        expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
        expect(await footerText(await mountIndicator($, surface))).toBe('Danxbot')
      })
    }

    test('not connected: no event line at all and nothing green', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      const all = await joined(pane)
      expect(all).not.toMatch(/events/)
      expect(all).not.toContain(NO_EVENT_BRIDGE)
      expect(await greens(pane)).toHaveLength(0)
    })

    test('R-2: one load reads the same dashboard paths as before; a 60 s tick adds exactly one /api/plans load and updates the line', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect([...new Set(d.api.map(a => `${a.method} ${a.path}`))].sort()).toEqual(
        ['GET /api/issues/DX-1', 'GET /api/issues/DX-2', 'GET /api/issues/DX-9', 'GET /api/plans', 'GET /api/plans/23', 'GET /api/plans/23/cards'].sort(),
      )
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeDefined()
      const before = d.api.filter(a => a.path === '/api/plans').length
      d.setListener('unattached')
      await d.clock.advance(60_000)
      expect(d.api.filter(a => a.path === '/api/plans')).toHaveLength(before + 1)
      expect(await pane.find({ type: 'Text', text: /^events$/ })).toBeUndefined()
      expect(await joined(pane)).toContain(NEXT_STEP('unattached'))
    })
  })
}
