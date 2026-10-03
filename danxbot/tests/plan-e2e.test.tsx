// DX-4232 E2E: one whole operator session per surface through the real hooks module with a
// stand-in danx-dashboard MCP server: band at session start -> open pane -> Connect -> answer by
// option -> by typed text -> approve one action -> reject another with a note. Every step asserts
// the stand-in danxbot_api call it caused.
import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, expectRowCarries, startSession, toldModel } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`end to end on ${surface}`, () => {
    test('band, pane, connect, option answer, typed answer, approve, reject with a note', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.cards[1]!.problems.push({
        id: 23,
        type: 'action',
        statement: 'Rotate the key',
        open: true,
        solutions: [{ id: 231, title: 'Rotate it', recommended: true }],
      })
      await startSession($, d, surface)

      // 1. the band is there with no command typed
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(band)).toContain('Not connected to a plan')

      // 2. the Plan button opens the pane
      await band.press({ key: 'open-pane' })
      expect(d.opened.map(o => o.id)).toEqual(['danx-plan'])
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await text(pane)).toContain('Not connected to a plan')

      // 3. Connect binds the session, the band turns green, the model is told
      await pane.press({ key: 'connect' })
      await d.clock.settle()
      expect(d.calls.filter(c => c.tool === 'plan_connect').map(c => c.args.plan_id)).toEqual([23])
      expect(await text(band)).toContain('PLAN-23 · Danxbot plugin · 4 open problems')
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('green')
      expect(toldModel(d)).toHaveLength(1)

      // 4. answer by option
      await pane.press({ key: 'open-11' })
      await pane.press({ key: 'use-112' })
      await d.clock.settle()
      // 5. answer by typed text
      await pane.press({ key: 'open-21' })
      await pane.input({ key: 'free-21', text: 'neither' })
      await d.clock.settle()
      // 6. approve one action
      await pane.press({ key: 'open-12' })
      await pane.press({ key: 'use-121' })
      await d.clock.settle()
      // 7. reject another with a note
      await pane.press({ key: 'open-23' })
      await pane.press({ key: 'rej-231' })
      await pane.input({ key: 'rej-in-231', text: 'not this quarter' })
      await d.clock.settle()

      expect(d.writes().map(w => [w.method, w.path, w.body])).toEqual([
        ['POST', '/api/issues/DX-1/problems/11/answer', { solution_id: 112 }],
        ['POST', '/api/issues/DX-2/problems/21/answer', { freeform: 'neither' }],
        ['POST', '/api/issues/DX-1/problems/12/answer', { solution_id: 121 }],
        ['POST', '/api/issues/DX-2/problems/23/answer', { solution_id: 231, outcome: 'rejected', note: 'not this quarter' }],
      ])
      // all four answered problems left the pane, and the band counts none
      expect(await text(pane)).toContain('Nothing needs you on this plan.')
      expect(await text(band)).toContain('PLAN-23 · Danxbot plugin')
      expect(await text(band)).not.toContain('open problem')
      // the connect row plus one per answer, each naming what it is about
      const rows = toldModel(d)
      expect(rows).toHaveLength(5)
      expectRowCarries(rows[0]!, ['PLAN-23', 'plan_id 23'])
      expectRowCarries(rows[1]!, ['DX-1', 'PBLM-11', 'Best'])
      expectRowCarries(rows[2]!, ['DX-2', 'PBLM-21', '"neither"'])
      expectRowCarries(rows[3]!, ['DX-1', 'PBLM-12', 'Allow it'])
      expectRowCarries(rows[4]!, ['DX-2', 'PBLM-23', 'REJECTED', 'not this quarter'])
    })
  })
}
