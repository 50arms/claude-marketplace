import "./run-tests-with-npm-test.generated"
// CP-74 / DEC-583: Sign in is ALWAYS offered while the session holds no working connection (signed out, a failed load, an agent block),
// never only when the load reads as signed out, and a sign-in request the model started is drawn with its link and code whatever phase the load is in.
// A loaded, connected session shows neither. Two states keep their own rule and offer none: a key a person revoked (its stop, `KEY_REVOKED_HALT`), and the
// auto-mode block (the key is fine, the fix is the permission rule).
import { describe, expect } from 'claude-code/testing'

import { EMPTY } from '../hooks/plan/config'
import { signInOffered } from '../hooks/plan/words'
import { test, APPROVAL_REQUIRED, APPROVAL_URL, CONFIRM_CODE, SURFACES, dashboard, forceRefresh, linksOf, startSession } from './plan-kit'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as any
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
const connectCalls = (d: any) => d.calls.filter((c: any) => c.server === 'plugin:50arms:platform' && c.tool === 'plan_connect')
const modelConnect = (on: any) => on('tool.call', { tool: 'mcp__plugin_50arms_platform__plan_connect' }, () => ({ result: {}, text: JSON.stringify(APPROVAL_REQUIRED), isError: false }) as any)

describe('which views offer Sign in', () => {
  const view = (patch: object) => ({ ...EMPTY, ...patch }) as any
  test('a view with no working connection offers it: signed out, a failed load, an agent block', () => {
    expect(signInOffered(view({ phase: 'signed-out' }))).toBe(true)
    expect(signInOffered(view({ phase: 'error' }))).toBe(true)
    for (const agentBlock of ['agent_needed', 'agent_limit_reached', 'agent_not_held']) expect(signInOffered(view({ phase: 'ready', agentBlock }))).toBe(true)
  })
  test('a loading or loaded view, a revoked key and the auto-mode block offer none', () => {
    expect(signInOffered(view({ phase: 'loading' }))).toBe(false)
    expect(signInOffered(view({ phase: 'ready' }))).toBe(false)
    expect(signInOffered(view({ phase: 'key-revoked', revokedBy: 'dana' }))).toBe(false)
    expect(signInOffered(view({ phase: 'blocked' }))).toBe(false)
  })
})

for (const surface of SURFACES) {
  describe(`Sign in on the band on ${surface}`, () => {
    test('a failed load (Disconnected) offers Sign in', async ($, on) => {
      const d = dashboard(on, { sessionReadFails: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await texts(band)).toContain('50 Arms: Disconnected')
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })

    test('a plugin server that never connected (Disconnected) offers Sign in', async ($, on) => {
      const d = dashboard(on, { mcp: 'down' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await texts(band)).toContain('50 Arms: Disconnected')
      expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
    })

    test('a revoked key keeps its stop: no Sign in', async ($, on) => {
      const d = dashboard(on, { signedOut: 'revoked' })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await texts(band)).toContain('50 Arms: access revoked by dana')
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
    })

    for (const gate of ['agent_needed', 'agent_limit_reached', 'agent_not_held'] as const) {
      test(`the agent gate (${gate}) offers Sign in`, async ($, on) => {
        const d = dashboard(on, { connected: false })
        await startSession($, d, surface)
        const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
        d.world.agentGate = gate
        await forceRefresh($, d)
        expect((await band.find({ key: 'sign-in' })).text).toBe('Sign in')
      })
    }

    test('a loaded, connected session shows no Sign in and no approval link', async ($, on) => {
      const d = dashboard(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await band.find({ key: 'sign-in' })).toBeUndefined()
      expect((await linksOf(band)).map(l => l.key)).not.toContain('approve-sign-in')
      expect(await texts(band)).not.toContain('Sign in')
    })

    test('Sign in pressed on a failed load asks the MCP to sign in, as it does signed out', async ($, on) => {
      const d = dashboard(on, { sessionReadFails: true })
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(connectCalls(d)).toHaveLength(0)
      await band.press({ key: 'sign-in' })
      await d.clock.settle()
      expect(connectCalls(d)).toHaveLength(1)
    })

    test("a request the model started while the load is a failed one is drawn with its link and code, and ends with the request", async ($, on) => {
      const d = dashboard(on, { sessionReadFails: true })
      modelConnect(on)
      await startSession($, d, surface)
      const band = await $.ui.mount({ plugin: '50arms', surface, ...BAND })
      expect(await texts(band)).toContain('50 Arms: Disconnected')
      // the key lapses behind the failed load: the model's connect is answered with a sign-in request
      d.world.signedOut = 'signed-out'
      await $.tool.call({ tool: 'mcp__plugin_50arms_platform__plan_connect', plan_id: 23 } as any)
      await d.clock.settle()
      // the request is open; the next read of the session then fails (the key reads valid to the dashboard, the read itself fails): the band reads Disconnected
      d.world.signedOut = null
      await forceRefresh($, d)
      expect(await texts(band)).toContain('50 Arms: Disconnected')
      expect((await linksOf(band)).map(l => l.href)).toContain(APPROVAL_URL)
      expect(await texts(band)).toContain(`code ${CONFIRM_CODE}`)
      expect((await band.find({ key: 'sign-in' })).text).toBe('Signing in…')
      // approved: the link and code go
      d.world.signIn.approved = true
      await d.clock.advance(45_000)
      await d.clock.settle()
      expect((await linksOf(band)).map(l => l.href)).not.toContain(APPROVAL_URL)
      expect(await texts(band)).not.toContain(`code ${CONFIRM_CODE}`)
    })
  })
}
