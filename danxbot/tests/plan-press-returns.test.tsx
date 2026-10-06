// DX-4635: a Connect, Switch to or Disconnect press returns once its own plan_connect outcome is known and shown; the refresh, the
// model's note and the syncs run detached, their failures still shown, and the card reads of one load overlap.
import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, expectRowCarries, startSession, toldModel } from './plan-kit'

const PANE = { component: 'Pane', requestId: 'danx-plan', props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' } } as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const SLOW_MS = 30_000

for (const surface of SURFACES) {
  describe(`a press returns before the refresh on ${surface}`, () => {
    test('Connect: the press resolves while the refresh is slow, the pane shows the plan from the answer, then the full load fills it', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      await pane.select({ key: 'plan-pick', value: '23' })
      d.holdApi(SLOW_MS)

      let pressed = false
      const press = pane.press({ key: 'connect' }).then(() => void (pressed = true))
      await d.clock.advance(1_000)
      await press
      expect(pressed).toBe(true)
      // the full refresh has not finished: no needs-you read has answered yet
      expect(d.toasts).toContain('Connected to PLAN-23')
      expect(await text(pane)).toContain('Connected: PLAN-23')
      expect(await pane.find({ key: 'disconnect' })).toBeDefined()
      expect(await text(pane)).not.toContain('Nothing needs you')
      // R-4: the model's note was appended in the same step, once
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-23'])

      d.holdApi(0)
      await d.clock.settle()
      expect(await text(pane)).toContain('Connected: PLAN-23')
      expect(toldModel(d)).toHaveLength(1)
    })

    test('Disconnect: the press resolves while the refresh is slow and the pane shows not connected', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      d.holdApi(SLOW_MS)
      const press = pane.press({ key: 'disconnect' })
      await d.clock.advance(1_000)
      await press
      expect(d.toasts).toContain('Disconnected from PLAN-23')
      expect(await text(pane)).toContain('Not connected to a plan')
      expect(toldModel(d)).toHaveLength(1)
      d.holdApi(0)
      await d.clock.settle()
      expect(await text(pane)).toContain('Not connected to a plan')
    })

    test('a refresh that fails after the press is still shown', async ($, on) => {
      const d = dashboard(on, { connected: false })
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      await pane.select({ key: 'plan-pick', value: '23' })
      d.failList()
      await pane.press({ key: 'connect' })
      await d.clock.settle()
      expect(d.toasts).toContain('Connected to PLAN-23')
      expect(await text(pane)).not.toContain('Connected: PLAN-23')
      expect(await text(pane)).toMatch(/GET \/api\/plans|500|error/i)
    })

    test('the needs-you and in-progress card reads of one load are in flight together', async ($, on) => {
      const d = dashboard(on)
      d.holdApi(100)
      await $.session.start({ cwd: '/work', surface, isInteractive: true })
      await d.clock.advance(5_000)
      await d.clock.settle()
      // every card read of the load (the needs-you cards and the in-progress DX-9) was in flight at once, none waiting for another group
      const reads = d.api.filter(a => a.path.startsWith('/api/issues/'))
      expect(d.api.filter(a => a.path === '/api/plans')).toHaveLength(1)
      expect(reads.length).toBeGreaterThan(1)
      expect(d.issueReads.max).toBe(reads.length)
    })
  })
}
