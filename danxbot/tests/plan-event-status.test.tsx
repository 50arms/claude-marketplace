import "./run-tests-with-npm-test.generated"
// DX-4374 / DX-5605: the events warning is session state plus one toast, never band text: nothing while the listener is `healthy`, the
// server's state otherwise, never silent without a listener. The band draws sign-in, the plan and Disconnect only (the band file's tests).
import { describe, expect } from 'claude-code/testing'

import { NO_EVENT_STATUS } from '../hooks/plan/config'
import { test, LISTENER_STATES, eventsWarned, NEXT_STEP, SURFACES, dashboard, footerText, mountIndicator, startSession, forceRefresh } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
// the band's one Text that would carry an events status: none, whatever the listener says
const warning = async (ui: any) => (await ui.findAll({ type: 'Text' })).find((t: any) => t.text.startsWith('events') || t.text === NO_EVENT_STATUS)
const joined = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`the events warning on ${surface}`, () => {
    test('healthy: no warning is stored, toasted or drawn', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(eventsWarned(d)).toBeNull()
      expect(d.toasts.filter(t => t.startsWith('events'))).toEqual([])
      expect(await warning(band)).toBeUndefined()
      expect(await joined(band)).not.toContain('events')
    })

    for (const state of LISTENER_STATES.filter(s => s !== 'healthy')) {
      test(`${state}: the state name is the stored warning and its toast carries the next step, and the band draws nothing`, async ($, on) => {
        const d = dashboard(on, { listener: state })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        expect(eventsWarned(d)).toBe(`events: ${state}`)
        expect(d.toasts).toContain(`events: ${state}. ${NEXT_STEP(state)}`)
        expect(await warning(band)).toBeUndefined()
      })
    }

    test('an unknown state string is the stored warning as that string; only `healthy` is silent', async ($, on) => {
      const d = dashboard(on, { listener: 'Healthy' })
      await startSession($, d, surface)
      expect(eventsWarned(d)).toBe('events: Healthy')
      expect(d.toasts).toContain(`events: Healthy. ${NEXT_STEP('Healthy')}`)
    })

    test('connected with no listener row: the stored warning says so (no next step, so no toast)', async ($, on) => {
      const d = dashboard(on, { listener: null })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(eventsWarned(d)).toBe(NO_EVENT_STATUS)
      expect(d.toasts.filter(t => t.startsWith(NO_EVENT_STATUS))).toEqual([])
      expect(await joined(band)).not.toContain(NO_EVENT_STATUS)
    })

    // the state is the truth, not the `attached` flag: a reader keyed on `attached` would get both of these wrong
    test('attached true with a non-healthy state is the stored warning', async ($, on) => {
      const d = dashboard(on, { listener: 'credential_mismatch', attached: true })
      await startSession($, d, surface)
      expect(eventsWarned(d)).toBe('events: credential_mismatch')
    })

    test('attached false with the healthy state stores no warning: only the state decides', async ($, on) => {
      const d = dashboard(on, { listener: 'healthy', attached: false })
      await startSession($, d, surface)
      expect(eventsWarned(d)).toBeNull()
    })

    // a present-but-unreadable status fails the load like a bad dashboard_url; absent or null is the no-status line
    for (const [name, raw] of [
      ['a state that is not a string', { attached: true, state: 5, nextStep: null }],
      ['a next step that is neither a string nor null', { attached: true, state: 'stopped', nextStep: 7 }],
      ['no nextStep at all', { attached: true, state: 'stopped' }],
      ['a status that is not an object', 'healthy'],
    ] as const) {
      test(`${name}: the load fails, the footer reads 50 Arms disconnected, and no events warning is drawn`, async ($, on) => {
        const d = dashboard(on, { rawListener: raw })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
        expect(await joined(band)).not.toContain(NO_EVENT_STATUS)
        expect(eventsWarned(d)).toBeNull()
        expect(await footerText(await mountIndicator($, surface))).toBe('50 Arms disconnected')
      })
    }

    test('not connected: no events warning at all', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(eventsWarned(d)).toBeNull()
      expect(await joined(band)).not.toContain(NO_EVENT_STATUS)
    })

    test('R-2: a reload adds exactly one /api/plans load and updates the stored warning', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(eventsWarned(d)).toBeNull()
      const before = d.api.filter(a => a.path === '/api/plans').length
      d.setListener('unattached')
      await forceRefresh($, d)
      expect(d.api.filter(a => a.path === '/api/plans')).toHaveLength(before + 1)
      expect(eventsWarned(d)).toBe('events: unattached')
      expect(await warning(band)).toBeUndefined()
    })

    // DX-5232: the relay is "off" on every connect, before it starts, so "relay not running" must not borrow the listener's next step
    test('a fresh connect with an unhealthy listener never pairs the relay-not-running warning with the listener next step', async ($, on) => {
      const d = dashboard(on, { listener: 'stopped' })
      await startSession($, d, surface)
      expect(d.toasts.filter(t => t.startsWith('events: relay not running'))).toEqual([])
    })

    test('overlapping refreshes into the same warning toast it at most once', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      d.setListener('unattached')
      await Promise.all([forceRefresh($, d), forceRefresh($, d)])
      expect(d.toasts.filter(t => t.startsWith('events: unattached'))).toEqual([`events: unattached. ${NEXT_STEP('unattached')}`])
    })

    // DX-5232: a relay that stops (a write path of the relay) and a refresh (a write path of the load) both reach the events warning at once
    test('the relay stopping while refreshes run toasts the warning once, with the relay detail', async ($, on) => {
      const d = dashboard(on)
      d.relay.server.stopped = { reason: 'relay_failed', detail: 'the relay cannot go on', fix: 'Connect this session to a plan with plan_connect' }
      const started = startSession($, d, surface)
      await Promise.all([started, forceRefresh($, d), forceRefresh($, d)])
      await d.clock.settle()
      expect(d.toasts.filter(t => t.startsWith('events: relay stopped'))).toEqual(['events: relay stopped. Connect this session to a plan with plan_connect'])
    })

    test('a failed load toasts its reason once, on the change into the error', async ($, on) => {
      const d = dashboard(on, { listFails: true })
      await startSession($, d, surface)
      await forceRefresh($, d)
      expect(d.toasts.filter(t => t.startsWith('Plan load failed: '))).toHaveLength(1)
    })
  })
}
