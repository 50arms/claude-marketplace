import "./run-tests-with-npm-test.generated"
// DX-4374 / DX-5605: the footer is ONE pressable text: `<agent name> · PLAN-NN` for the team agent the session holds, `50 Arms disconnected` with none, and one press
// (the same function as /danx-plan) brings a dismissed band back (nothing is opened).
import { describe, expect } from 'claude-code/testing'

import { test, AGENT_NAME, SURFACES, answerPlanConnect, dashboard, footerText, forceRefresh, holdAgent, mountIndicator, pressFooter, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const counts = (o: Record<string, number>) => ({ 'In Progress': 0, ToDo: 0, Backlog: 0, Review: 0, Done: 0, Cancelled: 0, ...o })
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')

for (const surface of SURFACES) {
  describe(`the footer on ${surface}`, () => {
    test('connected with an agent: exactly one pressable, key footer-plan, reading the agent and PLAN-23; no Svg and no Text of its own', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      await holdAgent($, d)
      const footer = await mountIndicator($, surface, ['focus & memory paused'])
      // the desktop draws a Markdown link (no chip: a Button is a native button there), the terminal a plain Button
      const el = await footer.find({ key: 'footer-plan' })
      expect(el?.type).toBe(surface === 'desktop' ? 'Markdown' : 'Button')
      expect(await footer.findAll({ type: 'Button' })).toHaveLength(surface === 'desktop' ? 0 : 1)
      if (surface === 'terminal') {
        expect(el?.props.plain).toBe(true)
      }
      expect(await footerText(footer)).toBe(`${AGENT_NAME} · PLAN-23`)
      expect(await footer.find({ type: 'Svg' })).toBeUndefined()
      // the only Text is the engine's own mode label (the terminal Button's child Text is the indicator's, a Button's text)
      expect((await footer.findAll({ type: 'Text' })).map((t: any) => t.text).filter((t: string) => t !== `${AGENT_NAME} · PLAN-23`).join(' | ')).toBe('focus & memory paused')
    })

    test('the terminal text is coloured by the state; the desktop link takes no colour', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      await holdAgent($, d)
      const footer = await mountIndicator($, surface)
      const colored = await footer.find({ type: 'Text', text: `${AGENT_NAME} · PLAN-23` })
      // the default plan has open problems: attention, yellow
      if (surface === 'terminal') expect(colored?.props.color).toBe('yellow')
      else expect(colored).toBeUndefined()
    })

    for (const [name, options] of [['a plan connected', {}], ['no plan connected', { connected: false }]] as const) {
      test(`no agent held (${name}): the indicator reads 50 Arms disconnected`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        expect(await footerText(await mountIndicator($, surface))).toBe('50 Arms disconnected')
      })
    }

    test('an agent and no plan: the indicator reads the agent alone', async ($, on) => {
      const d = dashboard(on)
      answerPlanConnect(on, d)
      await startSession($, d, surface)
      await holdAgent($, d)
      // the model leaves the plan; the session still holds its agent
      await $.tool.call({ tool: 'mcp__plugin_danxbot_danx-dashboard__plan_connect', plan_id: 23, disconnect: true } as any)
      d.world.planId = null
      await forceRefresh($, d)
      expect(await footerText(await mountIndicator($, surface))).toBe(AGENT_NAME)
    })

    for (const [name, options] of [
      ['0%', { breakdown: counts({ ToDo: 4 }) }],
      ['50%', { breakdown: counts({ Done: 1, ToDo: 1 }) }],
      ['100%', { breakdown: counts({ Done: 5, Cancelled: 1 }) }],
    ] as const) {
      test(`${name}: the text is still exactly ${AGENT_NAME} · PLAN-23 (no percent, glyph or open count)`, async ($, on) => {
        const d = dashboard(on, options as any)
        answerPlanConnect(on, d)
        await startSession($, d, surface)
        await holdAgent($, d)
        expect(await footerText(await mountIndicator($, surface))).toBe(`${AGENT_NAME} · PLAN-23`)
      })
    }

    // the agent and the plan come from the plan-list read: a load that failed before it read the session names neither (the band says Disconnected then
    // too); one that failed after the session was read keeps both
    for (const [name, options] of [
      ['a plan-list 500', { listFails: true }],
      ['a thrown MCP call (timeout)', { mcp: 'flaky' }],
      ['a bad dashboard_url', { dashboardUrl: 'not a url' }],
    ] as const) {
      test(`${name}: the button reads 50 Arms disconnected, never error text`, async ($, on) => {
        const d = dashboard(on, options as any)
        d.world.agent = { id: 7, name: AGENT_NAME, avatar_url: null }
        await startSession($, d, surface)
        expect(await footerText(await mountIndicator($, surface))).toBe('50 Arms disconnected')
      })
    }

    for (const [name, options, label] of [
      ['a missing status_breakdown', { noBreakdown: true }, AGENT_NAME],
      ['a failed in-progress call (after the plan was read)', { inProgressFails: true }, `${AGENT_NAME} · PLAN-23`],
      ['an in-progress call with no total (after the plan was read)', { noInProgressTotal: true }, `${AGENT_NAME} · PLAN-23`],
    ] as const) {
      test(`${name}: the button reads ${label}, never error text`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        await holdAgent($, d)
        expect(await footerText(await mountIndicator($, surface))).toBe(label)
      })
    }

    // the plugin keeps no agent of its own: a resume or /clear (which empties plugin memory) and the next refresh read the same agent from the server
    for (const reason of ['resume', 'clear'] as const) {
      test(`after a ${reason} the footer still names the agent the server holds, never 50 Arms disconnected`, async ($, on) => {
        const d = dashboard(on)
        on('session.end', () => ({ sessionId: 's1' }) as any)
        await startSession($, d, surface)
        await holdAgent($, d)
        const footer = await mountIndicator($, surface)
        expect(await footerText(footer)).toBe(`${AGENT_NAME} · PLAN-23`)
        await $.session.end({ reason } as any)
        await forceRefresh($, d)
        expect(await footerText(footer)).toBe(`${AGENT_NAME} · PLAN-23`)
      })
    }

    test('a session agent with no name fails the load loudly: the band says error and the footer names no agent', async ($, on) => {
      const d = dashboard(on)
      d.world.agent = { id: 7, name: '', avatar_url: null }
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      expect(await text(band)).toContain('Disconnected')
      expect(await footerText(await mountIndicator($, surface))).toBe('50 Arms disconnected')
    })


    for (const [name, options] of [
      ['connected', {}],
      ['not connected', { connected: false }],
      ['an error view', { listFails: true }],
    ] as const) {
      test(`a press from ${name} clears dismissed; it tells the model nothing and toasts nothing of its own`, async ($, on) => {
        const d = dashboard(on, options as any)
        await startSession($, d, surface)
        // DX-5232: a failed load toasts its reason on the load itself; the press adds none
        const toastsBefore = [...d.toasts]
        const footer = await mountIndicator($, surface)
        await pressFooter(footer)
        await d.clock.settle()
        expect(d.stateWrites.filter(w => w.key === 'dismissed').map(w => w.value)).toEqual([false])
        expect(d.toasts).toEqual(toastsBefore)
        expect(d.relay.told).toEqual([])
        expect(d.writes()).toEqual([])
      })
    }

    test('on a dismissed band one press brings the band back; a second press hides nothing', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: 'danxbot', surface, ...BAND })
      const footer = await mountIndicator($, surface)
      await band.press({ key: 'band-close' })
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      await pressFooter(footer)
      expect(await band.find({ key: 'disconnect' })).toBeDefined()
      await pressFooter(footer)
      expect(await band.find({ key: 'disconnect' })).toBeDefined()
      expect(d.stateWrites.filter(w => w.key === 'dismissed').map(w => w.value)).toEqual([true, false, false])
    })

    test('/danx-plan and the footer press are one function: the same state writes', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const footer = await mountIndicator($, surface)
      await pressFooter(footer)
      const footerWrites = d.stateWrites.filter(w => w.key === 'dismissed')

      d.stateWrites.length = 0
      const ran = await $.command.run({ command: 'danx-plan' })
      await d.clock.settle()
      expect(JSON.stringify(ran)).toContain('Plan band shown.')
      expect(d.stateWrites.filter(w => w.key === 'dismissed')).toEqual(footerWrites)
    })
  })
}
