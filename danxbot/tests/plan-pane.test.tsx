import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, dashboard, expectRowCarries, expectText, startSession, toldModel } from './plan-kit'

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

describe('plan pane connects', () => {
  test('Connect binds the session with the session title, the band turns green, the model gets a row naming the plan', async ($, on) => {
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

      expect(d.calls.filter(c => c.tool === 'plan_connect')).toEqual([
        { server: 'danx-dashboard', tool: 'plan_connect', args: { plan_id: 23, title: 'PLAN-23: danxbot plugin' } },
      ])
      expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('green')
      expectText(await band.find({ type: 'Text', text: /PLAN-23/ }), /PLAN-23 · Danxbot plugin/)
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-23', 'Danxbot plugin', 'plan_id 23', 'plan_connect'])
      await band.unmount()
      await pane.unmount()
    }
  })

  test('Switch plan shows only while connected, rebinds to the plan picked and tells the model', async ($, on) => {
    const d = dashboard(on)
    for (const surface of SURFACES) {
      d.calls.length = 0
      d.toasts.length = 0
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
      const rows = toldModel(d)
      expect(rows).toHaveLength(1)
      expectRowCarries(rows[0]!, ['PLAN-24', 'Agent mode', 'plan_id 24'])
      await pane.unmount()
    }
  })

  test('a REFUSED connect (ok: false, never an error result) is shown as refused and tells the model nothing', async ($, on) => {
    const d = dashboard(on, { connected: false, connectFails: true })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(d.toasts.some(t => t.startsWith('Connected'))).toBe(false)
    expect(d.toasts.at(-1)).toMatch(/^Connect refused: 409 PLAN-24 is archived\. Restore it before doing this/)
    expect(toldModel(d)).toHaveLength(0)
    expect(await (await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')).toContain('Not connected to a plan')
  })

  test('a REFUSED Switch plan leaves the session on its plan and tells the model nothing', async ($, on) => {
    const d = dashboard(on, { connectFails: true })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    const band = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...BAND })
    await pane.press({ key: 'switch' })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(d.toasts.at(-1)).toMatch(/^Connect refused: 409 PLAN-24 is archived/)
    expect(toldModel(d)).toHaveLength(0)
    expect((await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')).toContain('PLAN-23')
  })

  test('a THROWN connect (the only error result) toasts with the rejection text and tells the model nothing', async ($, on) => {
    const d = dashboard(on, { connected: false, connectThrows: true })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(d.toasts.at(-1)).toMatch(/^Connect failed: .*the MCP server is outdated/)
    expect(toldModel(d)).toHaveLength(0)
  })

  test('CANARY: the day $.session.append works in claude plugin test, switch the model-row assertions to the appended row', async ($, on) => {
    const d = dashboard(on, { connected: false })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(
      toldModel(d),
      'session.append no longer rejects under claude plugin test, so the plugin fallback toast did not appear. ' +
        'Replace toldModel(d) in every test with the row the kit now records for $.session.append (see the note in plan-kit.tsx), then delete this canary.',
    ).toHaveLength(1)
  })
})

describe('the session title reaches plan_connect', () => {
  test('a title the app reports with a prompt (classic.UserPromptSubmit) is the one Connect passes', async ($, on) => {
    const d = dashboard(on, { connected: false })
    on('classic.UserPromptSubmit', () => ({}) as any)
    await startSession($, d, 'desktop')
    await $.classic.UserPromptSubmit({ prompt: 'hello', session_title: 'Renamed session' } as any)
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(d.calls.find(c => c.tool === 'plan_connect')?.args.title).toBe('Renamed session')
  })

  test('with no title reported, plan_connect gets no title at all', async ($, on) => {
    const d = dashboard(on, { connected: false })
    await startSession($, d, 'desktop')
    const pane = await $.ui.mount({ plugin: 'danxbot', surface: 'desktop', ...PANE })
    await pane.press({ key: 'connect' })
    await d.clock.settle()
    expect(d.calls.find(c => c.tool === 'plan_connect')?.args).toEqual({ plan_id: 23 })
  })
})
