import "./run-tests-with-npm-test.generated"
// The band's two buttons, each with its own job (CP-91). Disconnect shows while the session holds a plan or a card and only leaves it: the session stays signed in with its team agent.
// Revoke shows whenever the session holds a team agent, a plan or a card (operator, 2026-11-06: "If an agent is connected the band must ALWAYS show" a way to end it) and only ends the
// session's sign-in (CP-89 / DX-7026: the person-disconnect route frees the agent and revokes the key); it makes no leave call.
import { describe, expect } from 'claude-code/testing'

import { DISCONNECT_GLYPH } from '../hooks/plan/config'
import { PERSON_DISCONNECT_PATH, revokeFailure } from '../hooks/plan/agent'
import { test, SURFACES, dashboard, expectRowCarries, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const AGENT = { id: 6, name: 'Tendai', avatar_url: null }
const CARD = { id: 'DX-77', title: 'One-off fix' }
const text = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
const leaves = (d: any) => d.calls.filter((c: any) => c.tool === 'session_connect' && c.args.disconnect)
const planLeaves = (d: any) => leaves(d).filter((c: any) => c.args.target.startsWith('PLAN-'))
const cardLeaves = (d: any) => leaves(d).filter((c: any) => !c.args.target.startsWith('PLAN-'))

async function mounted($: any, d: any, surface: string) {
  await startSession($, d, surface)
  return await $.ui.mount({ plugin: '50arms', surface, ...BAND })
}

for (const surface of SURFACES) {
  describe(`Disconnect and Revoke for what the session holds, on ${surface}`, () => {
    test('an agent-only view shows Revoke and no Disconnect', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      expect((await band.find({ key: 'revoke' }))?.text).toBe('🔒')
    })

    test('a card-only view shows both', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.card = CARD
      const band = await mounted($, d, surface)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
      expect((await band.find({ key: 'revoke' }))?.text).toBe('🔒')
    })

    test('a plan view shows both', async ($, on) => {
      const band = await mounted($, dashboard(on), surface)
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
      expect((await band.find({ key: 'revoke' }))?.text).toBe('🔒')
    })

    test('a view holding no agent, plan or card shows neither', async ($, on) => {
      const band = await mounted($, dashboard(on, { connected: false }), surface)
      expect(await text(band)).toContain('50 Arms: not connected to a plan or card')
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      expect(await band.find({ key: 'revoke' })).toBeUndefined()
    })

    test('Revoke on an agent-only view: only the person-disconnect route is called, no toast, the model told, the band reads access revoked and offers Sign in', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      await band.press({ key: 'revoke' })
      await d.clock.settle()

      expect(d.world.leaveOrder).toEqual(['person-disconnect'])
      expect(d.personDisconnects).toEqual([{ method: 'POST', path: PERSON_DISCONNECT_PATH, background: true }])
      expect(d.releaseCalls).toEqual([])
      expect(leaves(d)).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Revoked'))).toEqual([])
      expect(d.relay.told).toHaveLength(1)
      expectRowCarries(d.relay.told[0]!, ['revoked', 'Revoke button', 'Do not call session_connect', 'Sign in'])
      expect(await text(band)).toContain('50 Arms: access revoked by dana')
      expect((await band.find({ key: 'sign-in' }))?.text).toBe('Sign in')
      expect(await band.find({ key: 'revoke' })).toBeUndefined()
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
    })

    test('Revoke on a plan view makes no leave call: the plan is not left, only the sign-in ends', async ($, on) => {
      const d = dashboard(on)
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      await band.press({ key: 'revoke' })
      await d.clock.settle()

      expect(leaves(d)).toEqual([])
      expect(d.world.leaveOrder).toEqual(['person-disconnect'])
      expect(d.personDisconnects).toHaveLength(1)
      expect(d.releaseCalls).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Revoked'))).toEqual([])
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected'))).toEqual([])
      expectRowCarries(d.relay.told[0]!, ['revoked', 'Revoke button', 'Do not call session_connect'])
      expect(await band.find({ key: 'revoke' })).toBeUndefined()
    })

    test('Disconnect on a card view: only the card is left, with its id; the agent and the key are kept and no sign-in is offered', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      const band = await mounted($, d, surface)
      expect(await text(band)).toContain('One-off fix')
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(cardLeaves(d)).toEqual([{ server: 'plugin:50arms:platform', tool: 'session_connect', args: { target: 'DX-77', disconnect: true } }])
      expect(d.world.leaveOrder).toEqual(['card'])
      expect(planLeaves(d)).toEqual([])
      expect(d.personDisconnects).toEqual([])
      expect(d.releaseCalls).toEqual([])
      expect(d.world.agent).toEqual(AGENT)
      expect(d.world.signedOut).toBe(null)
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected'))).toEqual([])
      expect(d.relay.told).toHaveLength(1)
      expectRowCarries(d.relay.told[0]!, ['DX-77', 'One-off fix', 'disconnected', 'still signed in', 'Do not call session_connect'])
      expect(await text(band)).toContain('50 Arms · Tendai: not connected to a plan or card')
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
      expect(await band.find({ key: 'disconnect' })).toBeUndefined()
      expect((await band.find({ key: 'revoke' }))?.text).toBe('🔒')
    })

    test('Disconnect on a plan view: only the plan is left, and the exit-time release is not asked', async ($, on) => {
      const d = dashboard(on)
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      await band.press({ key: 'disconnect' })
      await d.clock.settle()

      expect(planLeaves(d)).toEqual([{ server: 'plugin:50arms:platform', tool: 'session_connect', args: { target: 'PLAN-23', disconnect: true } }])
      expect(d.world.leaveOrder).toEqual(['plan'])
      expect(d.personDisconnects).toEqual([])
      expect(d.releaseCalls).toEqual([])
      expect(cardLeaves(d)).toEqual([])
      expect(d.world.agent).toEqual(AGENT)
      expect(d.toasts.filter((t: string) => t.startsWith('Disconnected'))).toEqual([])
      expectRowCarries(d.relay.told[0]!, ['PLAN-23', '50 Arms plugin', 'disconnected', 'still signed in', 'Do not call session_connect'])
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
    })

    test('Disconnect reads Disconnecting… while the leave runs, and a second press changes nothing; Revoke pressed meanwhile does nothing', async ($, on) => {
      const d = dashboard(on, { disconnectTakesMs: 5_000 })
      d.world.agent = AGENT
      const band = await mounted($, d, surface)
      const first = band.press({ key: 'disconnect' })
      await d.clock.settle()
      expect((await band.find({ key: 'disconnect' }))?.text).toBe('Disconnecting…')
      expect((await band.find({ key: 'disconnect' }))?.props.dimColor).toBe(true)
      await Promise.allSettled([band.press({ key: 'disconnect' }), band.press({ key: 'revoke' })])
      expect(planLeaves(d)).toHaveLength(1)
      expect(d.personDisconnects).toEqual([])
      await d.clock.advance(5_000)
      await first
      await d.clock.settle()
      expect(planLeaves(d)).toHaveLength(1)
      expect(d.world.leaveOrder).toEqual(['plan'])
      expect(d.personDisconnects).toEqual([])
      expect(d.relay.told).toHaveLength(1)
    })

    test('Revoke reads Revoking… while the call runs, a second press changes nothing, and Disconnect pressed meanwhile does nothing', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      d.world.release = { delayMs: 2_000 }
      const band = await mounted($, d, surface)
      const first = band.press({ key: 'revoke' })
      await d.clock.settle()
      expect((await band.find({ key: 'revoke' }))?.text).toBe('Revoking…')
      expect((await band.find({ key: 'revoke' }))?.props.dimColor).toBe(true)
      await Promise.allSettled([band.press({ key: 'revoke' }), band.press({ key: 'disconnect' })])
      expect(d.personDisconnects).toHaveLength(1)
      expect(leaves(d)).toEqual([])
      await d.clock.advance(2_000)
      await first
      await d.clock.settle()
      expect(d.personDisconnects).toHaveLength(1)
      expect(d.world.leaveOrder).toEqual(['person-disconnect'])
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

    test('Revoke failing: the failure is toasted, nothing else changes, the model is told nothing and the buttons stay', async ($, on) => {
      const d = dashboard(on, { connected: false })
      d.world.agent = AGENT
      d.world.card = CARD
      d.world.release = { status: 500 }
      const band = await mounted($, d, surface)
      await band.press({ key: 'revoke' })
      await d.clock.settle()
      expect(d.toasts.at(-1)).toBe(revokeFailure('500: release boom'))
      expect(d.relay.told).toHaveLength(0)
      expect(d.world.card).toEqual(CARD)
      expect(leaves(d)).toEqual([])
      expect(await text(band)).not.toContain('access revoked')
      expect((await band.find({ key: 'revoke' }))?.text).toBe('🔒')
      expect((await band.find({ key: 'disconnect' }))?.text).toBe(DISCONNECT_GLYPH)
    })
  })
}
