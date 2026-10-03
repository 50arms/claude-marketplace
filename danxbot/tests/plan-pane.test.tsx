import { describe, expect, test } from 'claude-code/testing'

import { connectNote } from '../hooks/plan-link/notes'
import { SURFACES, dashboard, expectText, startSession, triedToTell } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const PANE = {
  component: 'Pane',
  requestId: 'danx-plan',
  props: { title: 'Plan', isFocused: false, bodyColumns: 100, placement: 'dock' },
} as any

describe('plan pane opens', () => {
  test('the Plan button and /danx-plan open the pane danx-plan; nothing starts with /plan', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      await band.press({ key: 'open-pane' })
      await band.unmount()
    }
    expect(d.opened.map(o => o.id)).toEqual(['danx-plan', 'danx-plan'])

    const ran = await $.command.run({ command: 'danx-plan' })
    expect(ran.text).toBe('Plan pane opened.')
    await d.clock.settle()
    expect(d.opened.at(-1)?.id).toBe('danx-plan')

    // a name starting `/plan` is swallowed by the app's own plan-mode command
    expect(d.commands).toContain('danx-plan')
    for (const name of [...d.commands, ...d.opened.map(o => o.id)]) {
      expect(name.startsWith('plan')).toBe(false)
      expect(name.startsWith('/plan')).toBe(false)
    }
  })
})

describe('the note the model gets on connect', () => {
  test('names the plan and tells the model to read its briefing', () => {
    const note = connectNote({ id: 23, ref: 'PLAN-23', name: 'Danxbot plugin', status: 'building', needsYou: 0 })
    expect(note).toContain('PLAN-23')
    expect(note).toContain('Danxbot plugin')
    expect(note).toContain('plan_connect with plan_id 23')
  })
})

describe('plan pane connects', () => {
  test('Connect binds the session with the session title, the band turns green, the model gets a note', async ($, on) => {
    const d = dashboard(on, { connected: false })
    on('classic.SessionStart', () => ({}) as any)
    for (const surface of SURFACES) {
      d.world.planId = null
      d.toasts.length = 0
      d.calls.length = 0
      await $.classic.SessionStart({ source: 'startup', session_title: 'PLAN-23: danxbot plugin' } as any)
      await startSession($, d, surface)

      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('yellow')

      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expectText(await pane.find({ type: 'Text', text: /Not connected to a plan/ }), /Not connected/)
      expect(await pane.find({ key: 'switch' })).toBeUndefined()
      await pane.select({ key: 'plan-pick', value: '23' })
      await pane.press({ key: 'connect' })
      await d.clock.settle()

      const connect = d.calls.filter(c => c.tool === 'plan_connect')
      expect(connect).toEqual([
        { server: 'danx-dashboard', tool: 'plan_connect', args: { plan_id: 23, title: 'PLAN-23: danxbot plugin' } },
      ])
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('green')
      expectText(await band.find({ type: 'Text', text: /PLAN-23/ }), /PLAN-23 · Danxbot plugin/)
      // one row appended for the model (see plan-kit's note on how a test sees it), naming the plan
      expect(triedToTell(d)).toBe(1)
      await band.unmount()
      await pane.unmount()
    }
  })

  test('Switch plan shows only while connected and rebinds to the plan picked', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      d.calls.length = 0
      d.world.planId = 23
      await startSession($, d, surface)
      const pane = await $.ui.mount({ plugin: 'danxbot', surface, ...PANE })
      expect(await pane.find({ key: 'plan-pick' })).toBeUndefined()
      await pane.press({ key: 'switch' })
      // the picker offers the other, non-archived plans only
      const pick = await pane.find({ key: 'plan-pick' })
      expect(pick).toBeDefined()
      expect(JSON.stringify(pick!.props.options)).toContain('PLAN-24')
      expect(JSON.stringify(pick!.props.options)).not.toContain('PLAN-23')
      expect(JSON.stringify(pick!.props.options)).not.toContain('PLAN-25')
      await pane.press({ key: 'connect' })
      await d.clock.settle()
      expect(d.calls.filter(c => c.tool === 'plan_connect').map(c => c.args.plan_id)).toEqual([24])
      // switched: the control is gone again and the pane shows the new plan
      expect(await pane.find({ key: 'plan-pick' })).toBeUndefined()
      expectText(await pane.find({ type: 'Text', text: /Connected: PLAN-24/ }), /Connected: PLAN-24/)
      await pane.unmount()
    }
  })

  test('a failed connect toasts and appends nothing', async ($, on) => {
    const d = dashboard(on, { connected: false, connectFails: true })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(d.toasts.at(-1)).toMatch(/Connect failed: no such plan/)
    expect(triedToTell(d)).toBe(0)
  })
})
