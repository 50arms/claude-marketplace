import "./run-tests-with-npm-test.generated"
import { describe, expect } from 'claude-code/testing'

import { test, bandLabelOf, SURFACES, dashboard, footerText, forceRefresh, mountIndicator, needsYouBadgeOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const label = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')

for (const surface of SURFACES) {
  describe(`refresh without a polling timer on ${surface}`, () => {
    // DX-4233: the 60 s `$.clock.every` refresh is gone (no polling, DX-227's spirit): a relayed plan event is what tells the plugin
    // the plan moved, and the turns, sub-agents and buttons refresh as before.
    test('loads on session start, never again on the clock alone, and again when a plan event is relayed', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await needsYouBadgeOf(band)).toBe('⚠ 2')

      // a problem appears on a third card of the dashboard; ten minutes of clock bring no load
      d.world.cards.push({ id: 'DX-40', title: 'Third card', priority: 1, problems: [{ id: 22, type: 'question', statement: 'New?', open: true, solutions: [] }] })
      const loads = () => d.api.filter(a => a.path === '/api/plans').length
      const before = loads()
      await d.clock.advance(600_000)
      expect(loads()).toBe(before)
      expect(await needsYouBadgeOf(band)).toBe('⚠ 2')

      // the dashboard's event for that problem reaches the session: the relay delivers it and the plan is read again
      d.relay.push({ cursor: 'c7', text: 'operator opened a problem on DX-2' })
      await d.clock.settle()
      expect(loads()).toBe(before + 1)
      expect(await needsYouBadgeOf(band)).toBe('⚠ 3')
    })

    test('a refresh error shows `50 Arms: Disconnected` in the band', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      d.failList()
      await forceRefresh($, d)
      expect(await label(band)).toContain('50 Arms: Disconnected')
      expect(await footerText(await mountIndicator($, surface))).toBe('50 Arms disconnected')
      // and it recovers on the next good load
      d.failList(false)
      await forceRefresh($, d)
      expect(await needsYouBadgeOf(band)).toBe('⚠ 2')
    })
  })
}

describe('state keys', () => {
  test('everything the plugin keeps is under the plugin key danxbot; no plan-link key remains', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    await forceRefresh($, d)
    expect(d.stateWrites.length).toBeGreaterThan(0)
    expect([...new Set(d.stateWrites.map(w => w.plugin))]).toEqual(['danxbot'])
  })
})

describe('the dashboard cannot be read', () => {
  for (const surface of SURFACES) {
    test(`a rejection that is not "no such server" is an error shown as one, on ${surface}`, async ($, on) => {
      const d = dashboard(on, { mcp: 'flaky' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await label(band)).toContain('50 Arms: Disconnected')
      expect(await label(band)).not.toContain('not connected in this session')
      expect(await footerText(await mountIndicator($, surface))).toBe('50 Arms disconnected')
    })
  }
})

describe('the hooks that refresh', () => {
  test('the model connecting a plan (tool.call plan_connect) is shown at once', async ($, on) => {
    const d = dashboard(on, { connected: false })
    on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => {
      d.world.planId = 24
      return { result: {}, text: 'connected', isError: false } as any
    })
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    expect(await label(band)).toContain('50 Arms: not connected to a plan')
    await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 24 } as any)
    await d.clock.settle()
    expect(await bandLabelOf(band)).toBe('PLAN-24 · Agent mode')
  })

  test('a finished turn refreshes, but never twice within 10 s', async ($, on) => {
    const d = dashboard(on)
    on('turn.complete', () => ({ text: 'done' }) as any)
    await startSession($, d, 'desktop')
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    const loads = () => d.api.filter(a => a.path === '/api/plans').length
    d.world.cards.push({ id: 'DX-40', title: 'Third card', priority: 1, problems: [{ id: 22, type: 'question', statement: 'New?', open: true, solutions: [] }] })
    const turn = { reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 't1' } as any

    await d.clock.advance(5_000)
    const before = loads()
    await $.turn.complete(turn)
    await d.clock.settle()
    expect(loads()).toBe(before)
    expect(await needsYouBadgeOf(band)).toBe('⚠ 2')

    await d.clock.advance(6_000)
    await $.turn.complete(turn)
    await d.clock.settle()
    expect(loads()).toBe(before + 1)
    expect(await needsYouBadgeOf(band)).toBe('⚠ 3')
  })
})

describe('the refresh lock', () => {
  test('several session.start calls leave no timer: the clock alone makes no load', async ($, on) => {
    const d = dashboard(on)
    for (let i = 0; i < 3; i++) await startSession($, d, 'desktop')
    const loads = () => d.api.filter(a => a.path === '/api/plans').length
    const before = loads()
    await d.clock.advance(180_000)
    expect(loads()).toBe(before)
  })

  test('a refresh that throws releases the lock: the next one still loads', async ($, on) => {
    const d = dashboard(on)
    await startSession($, d, 'desktop')
    const loads = () => d.api.filter(a => a.path === '/api/plans').length
    // the host refuses the view write, in the load and again in its error handler: the throw escapes the refresh
    d.failViewWrite()
    try {
      await $.command.run({ command: 'danx-plan' })
    } catch {
      // the command may report its hook as failed: that is the throw being exercised
    }
    await d.clock.settle()
    // the throwing hook really fired (a renamed atom would make this test vacuous)
    expect(d.refusedViewWrites()).toBeGreaterThan(0)
    d.failViewWrite(false)
    const before = loads()
    await forceRefresh($, d)
    expect(loads()).toBe(before + 1)
  })
})
