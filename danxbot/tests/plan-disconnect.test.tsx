// DX-2985: the Plan pane's Disconnect button. plan_connect {plan_id, disconnect: true} takes the
// session off its plan; the model is told in the same step; every refusal is shown, never swallowed.
import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, expectRowCarries, startSession, toldModel } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const disconnectCalls = (d: any) => d.calls.filter((c: any) => c.tool === 'plan_connect' && c.args.disconnect)

async function mounted($: any, d: any, surface: string) {
  await startSession($, d, surface)
  const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
  const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
  return { band, pane }
}

for (const surface of SURFACES) {
  describe(`Disconnect on ${surface}`, () => {
    test('one call with the connected plan id and disconnect: true; the band and pane read not connected; the model is told', async ($, on) => {
      const d = dashboard(on)
      const { band, pane } = await mounted($, d, surface)
      expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
      expect((await pane.find({ key: 'disconnect' }))?.text).toBe('Disconnect')

      await pane.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(disconnectCalls(d)).toEqual([{ server: 'danx-dashboard', tool: 'plan_connect', args: { plan_id: 23, disconnect: true } }])
      expect(d.toasts).toContain('Disconnected from PLAN-23')
      expect(await text(band)).toContain('Danxbot: not connected to a plan')
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('yellow')
      expect(await text(pane)).toContain('Not connected to a plan')
      expect(await pane.find({ key: 'plan-pick' })).toBeDefined()
      expect(await pane.find({ key: 'disconnect' })).toBeUndefined()
      expect(await pane.find({ key: 'switch' })).toBeUndefined()

      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-23', 'Danxbot plugin', 'disconnected', 'no plan', '/api/plans/mine'])
    })

    test('the button reads Disconnecting… while the call is in flight, and a double press makes one call', async ($, on) => {
      const d = dashboard(on, { disconnectTakesMs: 5_000 })
      const { pane } = await mounted($, d, surface)
      const first = pane.press({ key: 'disconnect' })
      await d.clock.settle()
      expect((await pane.find({ key: 'disconnect' }))?.text).toBe('Disconnecting…')
      await Promise.allSettled([pane.press({ key: 'disconnect' })])
      expect(disconnectCalls(d)).toHaveLength(1)
      await d.clock.advance(5_000)
      await first
      expect(disconnectCalls(d)).toHaveLength(1)
      expect(toldModel(d)).toHaveLength(1)
    })

    test('plan_mismatch: the refusal names the real plan, nothing is told to the model, and the stale pane refreshes', async ($, on) => {
      const d = dashboard(on, { disconnect: 'mismatch' })
      const { band, pane } = await mounted($, d, surface)
      await pane.press({ key: 'disconnect' })
      await d.clock.settle()
      // the server's own sentence, then which plan the session really is on; no JSON dump
      expect(d.toasts.at(-1)).toBe(
        'Disconnect refused: 409 Session 41365fb5-6b43-443b-a01b-81245574f648 is on plan 24, not plan 23; nothing was changed. (PLAN-24 "Agent mode")',
      )
      expect(toldModel(d)).toHaveLength(0)
      // the refresh read the session's real plan
      expect(await text(band)).toContain('PLAN-24')
    })

    test('session_not_connected: shown, and the refresh shows not connected', async ($, on) => {
      const d = dashboard(on, { disconnect: 'notConnected' })
      const { band, pane } = await mounted($, d, surface)
      await pane.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe(
        'Disconnect refused: 409 Session 41365fb5-6b43-443b-a01b-81245574f648 is not connected to a plan, so there is nothing to leave.',
      )
      expect(toldModel(d)).toHaveLength(0)
      expect(await text(band)).toContain('Danxbot: not connected to a plan')
    })

    test('a 404 (the route is not deployed yet) carries its status and message; the plan stays connected', async ($, on) => {
      const d = dashboard(on, { disconnect: 'notFound' })
      const { band, pane } = await mounted($, d, surface)
      await pane.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts.at(-1)).toMatch(/^Disconnect refused: 404 Not found/)
      expect(toldModel(d)).toHaveLength(0)
      expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
      // the key was released: the button is back
      expect((await pane.find({ key: 'disconnect' }))?.text).toBe('Disconnect')
    })

    test('a 200 that names no plan left is a failure shown, not told to the model as fact; the pane reads the truth', async ($, on) => {
      const d = dashboard(on, { disconnect: 'noLeftPlan' })
      const { band, pane } = await mounted($, d, surface)
      await pane.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe('Disconnect failed: the answer named no plan left')
      expect(toldModel(d)).toHaveLength(0)
      expect(await text(band)).toContain('Danxbot: not connected to a plan')
    })

    test('a THROWN call (the only error result) is a toast with the rejection text', async ($, on) => {
      const d = dashboard(on, { disconnect: 'rejected' })
      const { pane } = await mounted($, d, surface)
      await pane.press({ key: 'disconnect' })
      expect(d.toasts.at(-1)).toMatch(/^Disconnect failed: .*plan_connect is not available/)
      expect(toldModel(d)).toHaveLength(0)
    })

    test('the model disconnecting (tool.call plan_connect) ends with the band showing not connected', async ($, on) => {
      const d = dashboard(on)
      on('tool.call', { tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect' }, () => {
        d.world.planId = null
        return { result: {}, text: 'disconnected', isError: false } as any
      })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23, disconnect: true } as any)
      await d.clock.settle()
      expect(await text(band)).toContain('Danxbot: not connected to a plan')
    })
  })
}
