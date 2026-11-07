import "./run-tests-with-npm-test.generated"
// The band's Disconnect shows whenever the session holds a team agent, a plan or a card (operator, 2026-11-06: "If an agent is connected the band must
// ALWAYS show a disconnect button"), and its press fully disconnects: the plan or the card is left, then the agent is released.
import { describe, expect } from 'claude-code/testing'

import { DISCONNECT_GLYPH } from '../hooks/plan/config'
import { test, SURFACES, dashboard, expectRowCarries, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const AGENT = { id: 6, name: 'Tendai', avatar_url: null }
const CARD = { id: 'DX-77', title: 'One-off fix' }
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const planLeaves = (d: any) => d.calls.filter((c: any) => c.tool === 'plan_connect' && c.args.disconnect)
const cardLeaves = (d: any) => d.api.filter((c: any) => c.method === 'DELETE' && c.path === '/api/plan-sessions/me/card')

async function mounted($: any, d: any, surface: string) {
  await startSession($, d, surface)
  return await $.ui.mount({ plugin: '50arms', surface, ...BAND })
}

for (const surface of SURFACES) {
  describe(`Disconnect for what the session holds, on ${surface}`, () => {
    test('shows on an agent-only view', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    })

    test('shows on a card-only view', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      const band = await mounted($, d, surface)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    })

    test('shows on a plan view', async ($, on) => {
      const band = await mounted($, dashboard(on), surface)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    })

    test('does not show on a view holding no agent, plan or card', async ($, on) => {
      const band = await mounted($, dashboard(on, { connected: false }), surface)
      expect(await text(band)).toContain('50 Arms: not connected to a plan or card')
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
    })

    test('agent only: the agent is released (no plan or card call), one toast, the model told, the band reads not connected', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(d.world.leaveOrder).toEqual(['release'])
      expect(planLeaves(d)).toEqual([])
      expect(cardLeaves(d)).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected'))).toEqual(['Disconnected team agent Tendai'])
      expect(d.relay.told).toHaveLength(1)
      expectRowCarries(d.relay.told[0]!, ['disconnected', 'freed its team agent', 'no plan or card', 'plan_connect', 'card_connect'])
      expect(await text(band)).toContain('50 Arms: not connected to a plan or card')
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
    })

    test('card held: the card is left with its id, then the agent is released; the model is told', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      const band = await mounted($, d, surface)
      expect(await text(band)).toContain('One-off fix')
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(cardLeaves(d)).toEqual([{ method: 'DELETE', path: '/api/plan-sessions/me/card', query: { card_id: 'DX-77' } }])
      expect(d.world.leaveOrder).toEqual(['card', 'release'])
      expect(planLeaves(d)).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected'))).toEqual(['Disconnected from DX-77'])
      expect(d.relay.told).toHaveLength(1)
      expectRowCarries(d.relay.told[0]!, ['DX-77', 'One-off fix', 'disconnected', 'freed its team agent', 'card_connect'])
      expect(await text(band)).toContain('50 Arms: not connected to a plan or card')
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
    })

    test('plan held: the plan is left first, then the agent is released', async ($, on) => {
      const d = dashboard(on)
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(planLeaves(d)).toEqual([{ server: 'plugin:50arms:platform', tool: 'plan_connect', args: { plan_id: 23, disconnect: true } }])
      // the plan's leave already freed the agent (the agent gate then answers agent_not_held), and the release is still asked for, once, after it
      expect(d.world.leaveOrder).toEqual(['plan'])
      expect(d.releaseCalls).toHaveLength(1)
      expect(cardLeaves(d)).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected'))).toEqual(['Disconnected from PLAN-23'])
      expectRowCarries(d.relay.told[0]!, ['PLAN-23', '50 Arms plugin', 'disconnected', 'freed its team agent', 'plan_connect'])
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
    })

    test('the button reads Disconnecting… while the leave runs, and a second press changes nothing', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      d.world.release = { delayMs: 5_000 }
      const band = await mounted($, d, surface)
      const first = band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect((await band.find({ key: 'disconnect' }))?.text).toBe('Disconnecting…')
      expect((await band.find({ key: 'disconnect' }))?.props.dimColor).toBe(true)
      await Promise.allSettled([band.press({ key: 'disconnect' })])
      expect(cardLeaves(d)).toHaveLength(1)
      await d.clock.advance(5_000)
      await first
      expect(cardLeaves(d)).toHaveLength(1)
      expect(d.world.leaveOrder).toEqual(['card', 'release'])
      expect(d.relay.told).toHaveLength(1)
    })

    test('card_mismatch (the session holds another card now): refusal toasted, agent kept, model told nothing, the band refreshes', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      const band = await mounted($, d, surface)
      d.world.card = { id: 'DX-78', title: 'Newer card' }
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(d.toasts.at(-1)).toMatch(/^Disconnect refused: 409 Session \S+ holds DX-78, not DX-77; nothing was changed\.$/)
      expect(d.world.leaveOrder).toEqual([])
      expect(d.relay.told).toHaveLength(0)
      expect(await text(band)).toContain('Newer card')
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    })

    test('session_holds_no_card: refusal toasted, the refresh reads the agent alone, and the agent is not released', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      const band = await mounted($, d, surface)
      d.world.card = null
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(d.toasts.at(-1)).toMatch(/^Disconnect refused: 409 Session \S+ holds no card, so there is nothing to leave\.$/)
      expect(d.world.leaveOrder).toEqual([])
      expect(d.relay.told).toHaveLength(0)
      expect(await text(band)).toContain('50 Arms · Tendai: not connected to a plan or card')
    })

    test('any other card refusal carries its status and message; the card stays held', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      d.world.cardLeave = 'boom'
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(d.toasts.at(-1)).toBe('Disconnect refused: 500 card boom')
      expect(d.world.leaveOrder).toEqual([])
      expect(d.relay.told).toHaveLength(0)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
      expect((await band.find({ key: 'disconnect' }))?.props.dimColor).toBeFalsy()
    })

    test('a 200 that names no card left is a failure shown, not told to the model as fact', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      d.world.cardLeave = 'noLeftCard'
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(d.toasts.at(-1)).toBe('Disconnect failed: the answer named no card left')
      expect(d.world.leaveOrder).toEqual(['card'])
      expect(d.relay.told).toHaveLength(0)
    })

    test('a card left but the agent release failing: one toast says both, and the model is not told the agent was freed', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      d.world.release = { status: 500 }
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected from DX-77'))).toHaveLength(1)
      expect(d.toasts.at(-1)).toMatch(/^Disconnected from DX-77, but could not free this session's team agent \(500: release boom\)/)
      expect(d.relay.told).toHaveLength(1)
      expect(d.relay.told[0]).not.toContain('freed its team agent')
    })

    test('agent only and the release failing: the failure is toasted, the model is told nothing and the button stays', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.release = { status: 500 }
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect(d.toasts.at(-1)).toMatch(/^Could not free this session's team agent \(500: release boom\)/)
      expect(d.relay.told).toHaveLength(0)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    })
  })
}
